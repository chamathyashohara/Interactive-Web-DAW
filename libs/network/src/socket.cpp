#include "rr/network/socket.hpp"

#include <cstring>
#include <mutex>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <iphlpapi.h>
#include <windows.h>
using socklen_type = int;
#else
#include <arpa/inet.h>
#include <cerrno>
#include <fcntl.h>
#include <ifaddrs.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <net/if.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
using socklen_type = socklen_t;
#endif

namespace rr::net {
namespace {

#ifdef _WIN32
constexpr std::intptr_t kInvalid = static_cast<std::intptr_t>(INVALID_SOCKET);
SOCKET raw(std::intptr_t h) { return static_cast<SOCKET>(h); }
int last_error() { return WSAGetLastError(); }
bool would_block(int e) { return e == WSAEWOULDBLOCK; }
bool in_progress(int e) { return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS; }
std::string error_text(int e) {
    char buffer[256] = {};
    const DWORD n = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr,
                                   static_cast<DWORD>(e), 0, buffer, sizeof buffer, nullptr);
    std::string text(buffer, n);
    while (!text.empty() && (text.back() == '\r' || text.back() == '\n' || text.back() == ' ' || text.back() == '.')) {
        text.pop_back();
    }
    return text + " (WSA " + std::to_string(e) + ")";
}
std::string wide_to_utf8(const wchar_t* w) {
    if (!w) {
        return {};
    }
    const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    std::string out(n > 0 ? static_cast<std::size_t>(n - 1) : 0, '\0');
    if (n > 1) {
        WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
    }
    return out;
}
#else
constexpr std::intptr_t kInvalid = -1;
int raw(std::intptr_t h) { return static_cast<int>(h); }
int last_error() { return errno; }
bool would_block(int e) { return e == EWOULDBLOCK || e == EAGAIN; }
bool in_progress(int e) { return e == EINPROGRESS; }
std::string error_text(int e) { return std::string(std::strerror(e)) + " (errno " + std::to_string(e) + ")"; }
#endif

bool make_non_blocking(std::intptr_t h) {
#ifdef _WIN32
    u_long on = 1;
    return ioctlsocket(raw(h), FIONBIO, &on) == 0;
#else
    const int flags = fcntl(raw(h), F_GETFL, 0);
    return flags >= 0 && fcntl(raw(h), F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

void set_low_latency(std::intptr_t h) {
    int on = 1;
    setsockopt(raw(h), IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&on), sizeof on);
}

bool parse_address(const std::string& ipv4, std::uint16_t port, sockaddr_in& out) {
    std::memset(&out, 0, sizeof out);
    out.sin_family = AF_INET;
    out.sin_port = htons(port);
    return inet_pton(AF_INET, ipv4.c_str(), &out.sin_addr) == 1;
}

bool is_private(std::uint32_t host_order) {
    const std::uint32_t a = host_order >> 24;
    const std::uint32_t b = (host_order >> 16) & 0xFF;
    return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254);
}

}  // namespace

bool init_sockets(std::string& error) {
#ifdef _WIN32
    static std::once_flag once;
    static int result = 0;
    std::call_once(once, [] {
        WSADATA data;
        result = WSAStartup(MAKEWORD(2, 2), &data);
    });
    if (result != 0) {
        error = "WSAStartup failed: " + error_text(result);
        return false;
    }
#else
    (void)error;
#endif
    return true;
}

bool is_valid_ipv4(const std::string& text) noexcept {
    sockaddr_in a{};
    return parse_address(text, 0, a);
}

std::vector<NetInterface> list_ipv4_interfaces() {
    std::vector<NetInterface> found;
    std::vector<NetInterface> loopbacks;
#ifdef _WIN32
    ULONG size = 16 * 1024;
    std::vector<unsigned char> buffer(size);
    ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    ULONG rc = GetAdaptersAddresses(AF_INET, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()), &size);
    if (rc == ERROR_BUFFER_OVERFLOW) {
        buffer.resize(size);
        rc = GetAdaptersAddresses(AF_INET, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()), &size);
    }
    if (rc != NO_ERROR) {
        return found;
    }
    for (auto* a = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()); a; a = a->Next) {
        if (a->OperStatus != IfOperStatusUp) {
            continue;
        }
        for (auto* u = a->FirstUnicastAddress; u; u = u->Next) {
            if (u->Address.lpSockaddr->sa_family != AF_INET) {
                continue;
            }
            const auto* sin = reinterpret_cast<const sockaddr_in*>(u->Address.lpSockaddr);
            char text[INET_ADDRSTRLEN] = {};
            inet_ntop(AF_INET, &sin->sin_addr, text, sizeof text);
            NetInterface ni;
            ni.name = wide_to_utf8(a->FriendlyName);
            ni.address = text;
            ni.loopback = a->IfType == IF_TYPE_SOFTWARE_LOOPBACK;
            ni.private_lan = is_private(ntohl(sin->sin_addr.s_addr));
            (ni.loopback ? loopbacks : found).push_back(ni);
        }
    }
#else
    ifaddrs* list = nullptr;
    if (getifaddrs(&list) != 0) {
        return found;
    }
    for (ifaddrs* i = list; i; i = i->ifa_next) {
        if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET || !(i->ifa_flags & IFF_UP)) {
            continue;
        }
        const auto* sin = reinterpret_cast<const sockaddr_in*>(i->ifa_addr);
        char text[INET_ADDRSTRLEN] = {};
        inet_ntop(AF_INET, &sin->sin_addr, text, sizeof text);
        NetInterface ni{i->ifa_name, text, (i->ifa_flags & IFF_LOOPBACK) != 0, is_private(ntohl(sin->sin_addr.s_addr))};
        (ni.loopback ? loopbacks : found).push_back(ni);
    }
    freeifaddrs(list);
#endif
    if (loopbacks.empty()) {
        loopbacks.push_back(NetInterface{"Loopback (this PC only)", "127.0.0.1", true, false});
    }
    found.insert(found.end(), loopbacks.begin(), loopbacks.end());
    return found;
}

TcpSocket::~TcpSocket() {
    close();
}

TcpSocket::TcpSocket(TcpSocket&& other) noexcept : handle_(other.handle_) {
    other.handle_ = kInvalid;
}

TcpSocket& TcpSocket::operator=(TcpSocket&& other) noexcept {
    if (this != &other) {
        close();
        handle_ = other.handle_;
        other.handle_ = kInvalid;
    }
    return *this;
}

bool TcpSocket::valid() const noexcept {
    return handle_ != kInvalid;
}

void TcpSocket::close() noexcept {
    if (handle_ != kInvalid) {
#ifdef _WIN32
        closesocket(raw(handle_));
#else
        ::close(raw(handle_));
#endif
        handle_ = kInvalid;
    }
}

void TcpSocket::shutdown_send() noexcept {
    if (handle_ != kInvalid) {
#ifdef _WIN32
        ::shutdown(raw(handle_), SD_SEND);
#else
        ::shutdown(raw(handle_), SHUT_WR);
#endif
    }
}

bool TcpSocket::listen_on(const std::string& ipv4, std::uint16_t port, std::string& error) {
    close();
    sockaddr_in addr{};
    if (!parse_address(ipv4, port, addr)) {
        error = "not an IPv4 address: " + ipv4;
        return false;
    }
    handle_ = static_cast<std::intptr_t>(::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
    if (!valid()) {
        error = "socket() failed: " + error_text(last_error());
        return false;
    }
#ifdef _WIN32
    // Refuse to share the port with another process (SO_EXCLUSIVEADDRUSE).
    BOOL exclusive = TRUE;
    setsockopt(raw(handle_), SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof exclusive);
#else
    int reuse = 1;
    setsockopt(raw(handle_), SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
#endif
    if (::bind(raw(handle_), reinterpret_cast<const sockaddr*>(&addr), sizeof addr) != 0) {
        error = "cannot listen on " + ipv4 + ":" + std::to_string(port) + ": " + error_text(last_error()) +
                " (port in use by another program, or the address is not on this PC)";
        close();
        return false;
    }
    if (::listen(raw(handle_), 4) != 0 || !make_non_blocking(handle_)) {
        error = "listen() failed: " + error_text(last_error());
        close();
        return false;
    }
    return true;
}

TcpSocket TcpSocket::accept_pending(std::string& peer_address, std::string& error) {
    sockaddr_in peer{};
    socklen_type len = sizeof peer;
    const auto h = static_cast<std::intptr_t>(::accept(raw(handle_), reinterpret_cast<sockaddr*>(&peer), &len));
    if (h == kInvalid) {
        const int e = last_error();
        if (!would_block(e)) {
            error = "accept() failed: " + error_text(e);
        }
        return TcpSocket();
    }
    char text[INET_ADDRSTRLEN] = {};
    inet_ntop(AF_INET, &peer.sin_addr, text, sizeof text);
    peer_address = text;
    TcpSocket s(h);
    make_non_blocking(h);
    set_low_latency(h);
    return s;
}

bool TcpSocket::connect_start(const std::string& ipv4, std::uint16_t port, std::string& error) {
    close();
    sockaddr_in addr{};
    if (!parse_address(ipv4, port, addr)) {
        error = "not an IPv4 address: " + ipv4;
        return false;
    }
    handle_ = static_cast<std::intptr_t>(::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
    if (!valid() || !make_non_blocking(handle_)) {
        error = "socket() failed: " + error_text(last_error());
        close();
        return false;
    }
    set_low_latency(handle_);
    if (::connect(raw(handle_), reinterpret_cast<const sockaddr*>(&addr), sizeof addr) != 0) {
        const int e = last_error();
        if (!in_progress(e)) {
            error = "connect to " + ipv4 + ":" + std::to_string(port) + " failed: " + error_text(e);
            close();
            return false;
        }
    }
    return true;
}

int TcpSocket::connect_finished(std::string& error) {
    if (!valid()) {
        error = "socket closed";
        return -1;
    }
    fd_set write_set;
    fd_set error_set;
    FD_ZERO(&write_set);
    FD_ZERO(&error_set);
    FD_SET(raw(handle_), &write_set);
    FD_SET(raw(handle_), &error_set);
    timeval tv{0, 0};
    const int n = ::select(static_cast<int>(handle_ + 1), nullptr, &write_set, &error_set, &tv);
    if (n < 0) {
        error = "select() failed: " + error_text(last_error());
        return -1;
    }
    if (n == 0) {
        return 0;
    }
    int so_error = 0;
    socklen_type len = sizeof so_error;
    getsockopt(raw(handle_), SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&so_error), &len);
    if (so_error != 0 || FD_ISSET(raw(handle_), &error_set)) {
        error = "connection refused or unreachable: " + error_text(so_error != 0 ? so_error : last_error());
        return -1;
    }
    return 1;
}

long TcpSocket::send_some(const std::uint8_t* data, std::size_t size, std::string& error) {
#ifdef _WIN32
    const int n = ::send(raw(handle_), reinterpret_cast<const char*>(data), static_cast<int>(size), 0);
#else
    const ssize_t n = ::send(raw(handle_), data, size, MSG_NOSIGNAL);
#endif
    if (n < 0) {
        const int e = last_error();
        if (would_block(e)) {
            return 0;
        }
        error = "send failed: " + error_text(e);
        return -1;
    }
    return static_cast<long>(n);
}

long TcpSocket::recv_some(std::uint8_t* buffer, std::size_t size, std::string& error) {
#ifdef _WIN32
    const int n = ::recv(raw(handle_), reinterpret_cast<char*>(buffer), static_cast<int>(size), 0);
#else
    const ssize_t n = ::recv(raw(handle_), buffer, size, 0);
#endif
    if (n == 0) {
        return -2;
    }
    if (n < 0) {
        const int e = last_error();
        if (would_block(e)) {
            return 0;
        }
        error = "receive failed: " + error_text(e);
        return -1;
    }
    return static_cast<long>(n);
}

bool TcpSocket::wait(const std::vector<TcpSocket*>& read, const std::vector<TcpSocket*>& write, int timeout_ms) {
    fd_set read_set;
    fd_set write_set;
    FD_ZERO(&read_set);
    FD_ZERO(&write_set);
    std::intptr_t max_handle = 0;
    bool any = false;
    for (TcpSocket* s : read) {
        if (s && s->valid()) {
            FD_SET(raw(s->handle_), &read_set);
            max_handle = s->handle_ > max_handle ? s->handle_ : max_handle;
            any = true;
        }
    }
    for (TcpSocket* s : write) {
        if (s && s->valid()) {
            FD_SET(raw(s->handle_), &write_set);
            max_handle = s->handle_ > max_handle ? s->handle_ : max_handle;
            any = true;
        }
    }
    if (!any) {
#ifdef _WIN32
        Sleep(static_cast<DWORD>(timeout_ms));
#else
        usleep(static_cast<useconds_t>(timeout_ms) * 1000);
#endif
        return true;
    }
    timeval tv{timeout_ms / 1000, (timeout_ms % 1000) * 1000};
    return ::select(static_cast<int>(max_handle + 1), &read_set, &write_set, nullptr, &tv) >= 0;
}

bool TcpSocket::is_readable(const TcpSocket& s) {
    if (!s.valid()) {
        return false;
    }
    fd_set set;
    FD_ZERO(&set);
    FD_SET(raw(s.handle_), &set);
    timeval tv{0, 0};
    return ::select(static_cast<int>(s.handle_ + 1), &set, nullptr, nullptr, &tv) > 0;
}

bool TcpSocket::is_writable(const TcpSocket& s) {
    if (!s.valid()) {
        return false;
    }
    fd_set set;
    FD_ZERO(&set);
    FD_SET(raw(s.handle_), &set);
    timeval tv{0, 0};
    return ::select(static_cast<int>(s.handle_ + 1), nullptr, &set, nullptr, &tv) > 0;
}

}  // namespace rr::net
