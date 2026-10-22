#include "rr/network/Socket.h"

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
#include <mstcpip.h>
#include <windows.h>
#ifndef SIO_UDP_CONNRESET
#define SIO_UDP_CONNRESET _WSAIOW(IOC_VENDOR, 12)  // as in the Windows SDK's mstcpip.h; missing in some MinGW headers
#endif
using socklenType = int;
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
using socklenType = socklen_t;
#endif

namespace
{

#ifdef _WIN32
constexpr intptr_t kInvalid = static_cast<intptr_t>(INVALID_SOCKET);
SOCKET raw(intptr_t h) { return static_cast<SOCKET>(h); }
int lastError() { return WSAGetLastError(); }
bool wouldBlock(int e) { return e == WSAEWOULDBLOCK; }
bool inProgress(int e) { return e == WSAEWOULDBLOCK || e == WSAEINPROGRESS; }
std::string errorText(int e)
{
    char buffer[256] = {};
    const DWORD n = FormatMessageA(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr,
                                   static_cast<DWORD>(e), 0, buffer, sizeof buffer, nullptr);
    std::string text(buffer, n);
    while (!text.empty() && (text.back() == '\r' || text.back() == '\n' || text.back() == ' ' || text.back() == '.'))
    {
        text.pop_back();
    }
    return text + " (WSA " + std::to_string(e) + ")";
}
std::string wideToUtf8(const wchar_t* w)
{
    if (!w)
    {
        return {};
    }
    const int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    std::string out(n > 0 ? static_cast<size_t>(n - 1) : 0, '\0');
    if (n > 1)
    {
        WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), n, nullptr, nullptr);
    }
    return out;
}
#else
constexpr intptr_t kInvalid = -1;
int raw(intptr_t h) { return static_cast<int>(h); }
int lastError() { return errno; }
bool wouldBlock(int e) { return e == EWOULDBLOCK || e == EAGAIN; }
bool inProgress(int e) { return e == EINPROGRESS; }
std::string errorText(int e) { return std::string(std::strerror(e)) + " (errno " + std::to_string(e) + ")"; }
#endif

bool makeNonBlocking(intptr_t h)
{
#ifdef _WIN32
    u_long on = 1;
    return ioctlsocket(raw(h), FIONBIO, &on) == 0;
#else
    const int flags = fcntl(raw(h), F_GETFL, 0);
    return flags >= 0 && fcntl(raw(h), F_SETFL, flags | O_NONBLOCK) == 0;
#endif
}

void setLowLatency(intptr_t h)
{
    int on = 1;
    setsockopt(raw(h), IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&on), sizeof on);
}

bool parseAddress(const std::string& ipv4, uint16_t port, sockaddr_in& out)
{
    std::memset(&out, 0, sizeof out);
    out.sin_family = AF_INET;
    out.sin_port = htons(port);
    return inet_pton(AF_INET, ipv4.c_str(), &out.sin_addr) == 1;
}

bool isPrivate(uint32_t hostOrder)
{
    const uint32_t a = hostOrder >> 24;
    const uint32_t b = (hostOrder >> 16) & 0xFF;
    return a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254);
}

}  // namespace

bool initSockets(std::string& error)
{
#ifdef _WIN32
    static std::once_flag once;
    static int result = 0;
    std::call_once(once, [] {
        WSADATA data;
        result = WSAStartup(MAKEWORD(2, 2), &data);
    });
    if (result != 0)
    {
        error = "WSAStartup failed: " + errorText(result);
        return false;
    }
#else
    (void)error;
#endif
    return true;
}

bool isValidIpv4(const std::string& text) noexcept
{
    sockaddr_in a{};
    return parseAddress(text, 0, a);
}

std::vector<NetInterface> listIpv4Interfaces()
{
    std::vector<NetInterface> found;
    std::vector<NetInterface> loopbacks;
#ifdef _WIN32
    ULONG size = 16 * 1024;
    std::vector<unsigned char> buffer(size);
    ULONG flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    ULONG rc = GetAdaptersAddresses(AF_INET, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()), &size);
    if (rc == ERROR_BUFFER_OVERFLOW)
    {
        buffer.resize(size);
        rc = GetAdaptersAddresses(AF_INET, flags, nullptr, reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()), &size);
    }
    if (rc != NO_ERROR)
    {
        return found;
    }
    for (auto* a = reinterpret_cast<IP_ADAPTER_ADDRESSES*>(buffer.data()); a; a = a->Next)
    {
        if (a->OperStatus != IfOperStatusUp)
        {
            continue;
        }
        for (auto* u = a->FirstUnicastAddress; u; u = u->Next)
        {
            if (u->Address.lpSockaddr->sa_family != AF_INET)
            {
                continue;
            }
            const auto* sin = reinterpret_cast<const sockaddr_in*>(u->Address.lpSockaddr);
            char text[INET_ADDRSTRLEN] = {};
            inet_ntop(AF_INET, &sin->sin_addr, text, sizeof text);
            NetInterface ni;
            ni.name = wideToUtf8(a->FriendlyName);
            ni.address = text;
            ni.loopback = a->IfType == IF_TYPE_SOFTWARE_LOOPBACK;
            ni.privateLan = isPrivate(ntohl(sin->sin_addr.s_addr));
            (ni.loopback ? loopbacks : found).push_back(ni);
        }
    }
#else
    ifaddrs* list = nullptr;
    if (getifaddrs(&list) != 0)
    {
        return found;
    }
    for (ifaddrs* i = list; i; i = i->ifa_next)
    {
        if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET || !(i->ifa_flags & IFF_UP))
        {
            continue;
        }
        const auto* sin = reinterpret_cast<const sockaddr_in*>(i->ifa_addr);
        char text[INET_ADDRSTRLEN] = {};
        inet_ntop(AF_INET, &sin->sin_addr, text, sizeof text);
        NetInterface ni{i->ifa_name, text, (i->ifa_flags & IFF_LOOPBACK) != 0, isPrivate(ntohl(sin->sin_addr.s_addr))};
        (ni.loopback ? loopbacks : found).push_back(ni);
    }
    freeifaddrs(list);
#endif
    if (loopbacks.empty())
    {
        loopbacks.push_back(NetInterface{"Loopback (this PC only)", "127.0.0.1", true, false});
    }
    found.insert(found.end(), loopbacks.begin(), loopbacks.end());
    return found;
}

TcpSocket::~TcpSocket()
{
    close();
}

TcpSocket::TcpSocket(TcpSocket&& other) noexcept : handle(other.handle)
{
    other.handle = kInvalid;
}

TcpSocket& TcpSocket::operator=(TcpSocket&& other) noexcept
{
    if (this != &other)
    {
        close();
        handle = other.handle;
        other.handle = kInvalid;
    }
    return *this;
}

bool TcpSocket::valid() const noexcept
{
    return handle != kInvalid;
}

void TcpSocket::close() noexcept
{
    if (handle != kInvalid)
    {
#ifdef _WIN32
        closesocket(raw(handle));
#else
        ::close(raw(handle));
#endif
        handle = kInvalid;
    }
}

void TcpSocket::shutdownSend() noexcept
{
    if (handle != kInvalid)
    {
#ifdef _WIN32
        ::shutdown(raw(handle), SD_SEND);
#else
        ::shutdown(raw(handle), SHUT_WR);
#endif
    }
}

bool TcpSocket::listenOn(const std::string& ipv4, uint16_t port, std::string& error)
{
    close();
    sockaddr_in addr{};
    if (!parseAddress(ipv4, port, addr))
    {
        error = "not an IPv4 address: " + ipv4;
        return false;
    }
    handle = static_cast<intptr_t>(::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
    if (!valid())
    {
        error = "socket() failed: " + errorText(lastError());
        return false;
    }
#ifdef _WIN32
    // Refuse to share the port with another process (SO_EXCLUSIVEADDRUSE).
    BOOL exclusive = TRUE;
    setsockopt(raw(handle), SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof exclusive);
#else
    int reuse = 1;
    setsockopt(raw(handle), SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof reuse);
#endif
    if (::bind(raw(handle), reinterpret_cast<const sockaddr*>(&addr), sizeof addr) != 0)
    {
        error = "cannot listen on " + ipv4 + ":" + std::to_string(port) + ": " + errorText(lastError()) +
                " (port in use by another program, or the address is not on this PC)";
        close();
        return false;
    }
    if (::listen(raw(handle), 4) != 0 || !makeNonBlocking(handle))
    {
        error = "listen() failed: " + errorText(lastError());
        close();
        return false;
    }
    return true;
}

TcpSocket TcpSocket::acceptPending(std::string& peerAddress, std::string& error)
{
    sockaddr_in peer{};
    socklenType len = sizeof peer;
    const auto h = static_cast<intptr_t>(::accept(raw(handle), reinterpret_cast<sockaddr*>(&peer), &len));
    if (h == kInvalid)
    {
        const int e = lastError();
        if (!wouldBlock(e))
        {
            error = "accept() failed: " + errorText(e);
        }
        return TcpSocket();
    }
    char text[INET_ADDRSTRLEN] = {};
    inet_ntop(AF_INET, &peer.sin_addr, text, sizeof text);
    peerAddress = text;
    TcpSocket s(h);
    makeNonBlocking(h);
    setLowLatency(h);
    return s;
}

bool TcpSocket::connectStart(const std::string& ipv4, uint16_t port, std::string& error)
{
    close();
    sockaddr_in addr{};
    if (!parseAddress(ipv4, port, addr))
    {
        error = "not an IPv4 address: " + ipv4;
        return false;
    }
    handle = static_cast<intptr_t>(::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
    if (!valid() || !makeNonBlocking(handle))
    {
        error = "socket() failed: " + errorText(lastError());
        close();
        return false;
    }
    setLowLatency(handle);
    if (::connect(raw(handle), reinterpret_cast<const sockaddr*>(&addr), sizeof addr) != 0)
    {
        const int e = lastError();
        if (!inProgress(e))
        {
            error = "connect to " + ipv4 + ":" + std::to_string(port) + " failed: " + errorText(e);
            close();
            return false;
        }
    }
    return true;
}

int TcpSocket::connectFinished(std::string& error)
{
    if (!valid())
    {
        error = "socket closed";
        return -1;
    }
    fd_set writeSet;
    fd_set errorSet;
    FD_ZERO(&writeSet);
    FD_ZERO(&errorSet);
    FD_SET(raw(handle), &writeSet);
    FD_SET(raw(handle), &errorSet);
    timeval tv{0, 0};
    const int n = ::select(static_cast<int>(handle + 1), nullptr, &writeSet, &errorSet, &tv);
    if (n < 0)
    {
        error = "select() failed: " + errorText(lastError());
        return -1;
    }
    if (n == 0)
    {
        return 0;
    }
    int soError = 0;
    socklenType len = sizeof soError;
    getsockopt(raw(handle), SOL_SOCKET, SO_ERROR, reinterpret_cast<char*>(&soError), &len);
    if (soError != 0 || FD_ISSET(raw(handle), &errorSet))
    {
        error = "connection refused or unreachable: " + errorText(soError != 0 ? soError : lastError());
        return -1;
    }
    return 1;
}

long TcpSocket::sendSome(const uint8_t* data, size_t size, std::string& error)
{
#ifdef _WIN32
    const int n = ::send(raw(handle), reinterpret_cast<const char*>(data), static_cast<int>(size), 0);
#else
    const ssize_t n = ::send(raw(handle), data, size, MSG_NOSIGNAL);
#endif
    if (n < 0)
    {
        const int e = lastError();
        if (wouldBlock(e))
        {
            return 0;
        }
        error = "send failed: " + errorText(e);
        return -1;
    }
    return static_cast<long>(n);
}

long TcpSocket::recvSome(uint8_t* buffer, size_t size, std::string& error)
{
#ifdef _WIN32
    const int n = ::recv(raw(handle), reinterpret_cast<char*>(buffer), static_cast<int>(size), 0);
#else
    const ssize_t n = ::recv(raw(handle), buffer, size, 0);
#endif
    if (n == 0)
    {
        return -2;
    }
    if (n < 0)
    {
        const int e = lastError();
        if (wouldBlock(e))
        {
            return 0;
        }
        error = "receive failed: " + errorText(e);
        return -1;
    }
    return static_cast<long>(n);
}

bool TcpSocket::wait(const std::vector<TcpSocket*>& read, const std::vector<TcpSocket*>& write, int timeoutMs)
{
    fd_set readSet;
    fd_set writeSet;
    FD_ZERO(&readSet);
    FD_ZERO(&writeSet);
    intptr_t maxHandle = 0;
    bool any = false;
    for (TcpSocket* s : read)
    {
        if (s && s->valid())
        {
            FD_SET(raw(s->handle), &readSet);
            maxHandle = s->handle > maxHandle ? s->handle : maxHandle;
            any = true;
        }
    }
    for (TcpSocket* s : write)
    {
        if (s && s->valid())
        {
            FD_SET(raw(s->handle), &writeSet);
            maxHandle = s->handle > maxHandle ? s->handle : maxHandle;
            any = true;
        }
    }
    if (!any)
    {
#ifdef _WIN32
        Sleep(static_cast<DWORD>(timeoutMs));
#else
        usleep(static_cast<useconds_t>(timeoutMs) * 1000);
#endif
        return true;
    }
    timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
    return ::select(static_cast<int>(maxHandle + 1), &readSet, &writeSet, nullptr, &tv) >= 0;
}

bool TcpSocket::isReadable(const TcpSocket& s)
{
    if (!s.valid())
    {
        return false;
    }
    fd_set set;
    FD_ZERO(&set);
    FD_SET(raw(s.handle), &set);
    timeval tv{0, 0};
    return ::select(static_cast<int>(s.handle + 1), &set, nullptr, nullptr, &tv) > 0;
}

bool TcpSocket::isWritable(const TcpSocket& s)
{
    if (!s.valid())
    {
        return false;
    }
    fd_set set;
    FD_ZERO(&set);
    FD_SET(raw(s.handle), &set);
    timeval tv{0, 0};
    return ::select(static_cast<int>(s.handle + 1), nullptr, &set, nullptr, &tv) > 0;
}

// ---------------------------------------------------------------------------------------------
// UDP (live media, ADR-017)

std::string ipv4Text(uint32_t ip)
{
    in_addr a{};
    a.s_addr = htonl(ip);
    char text[INET_ADDRSTRLEN] = {};
    inet_ntop(AF_INET, &a, text, sizeof text);
    return text;
}

std::string Endpoint::text() const
{
    return ipv4Text(ip) + ":" + std::to_string(port);
}

bool parseEndpoint(const std::string& ipv4, uint16_t port, Endpoint& out) noexcept
{
    sockaddr_in a{};
    if (!parseAddress(ipv4, port, a))
    {
        return false;
    }
    out.ip = ntohl(a.sin_addr.s_addr);
    out.port = port;
    return true;
}

UdpSocket::~UdpSocket()
{
    close();
}

bool UdpSocket::valid() const noexcept
{
    return handle != kInvalid;
}

void UdpSocket::close() noexcept
{
    if (handle != kInvalid)
    {
#ifdef _WIN32
        closesocket(raw(handle));
#else
        ::close(raw(handle));
#endif
        handle = kInvalid;
    }
}

bool UdpSocket::open(std::string& error)
{
    close();
    handle = static_cast<intptr_t>(::socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP));
    if (!valid() || !makeNonBlocking(handle))
    {
        error = "socket() failed: " + errorText(lastError());
        close();
        return false;
    }
#ifdef _WIN32
    // Without this, an ICMP "port unreachable" (peer not listening yet) makes the next
    // recvfrom() fail with WSAECONNRESET (seen in the 2026 C++ prototype).
    BOOL report = FALSE;
    DWORD returned = 0;
    WSAIoctl(raw(handle), SIO_UDP_CONNRESET, &report, sizeof report, nullptr, 0, &returned, nullptr, nullptr);
#endif
    return true;
}

bool UdpSocket::bindOn(const std::string& ipv4, uint16_t port, std::string& error)
{
    sockaddr_in addr{};
    if (!parseAddress(ipv4, port, addr))
    {
        error = "not an IPv4 address: " + ipv4;
        return false;
    }
    if (addr.sin_addr.s_addr == htonl(INADDR_ANY))
    {
        error = "refusing to receive on all interfaces (0.0.0.0): choose one network interface";
        return false;
    }
    if (!open(error))
    {
        return false;
    }
#ifdef _WIN32
    BOOL exclusive = TRUE;
    setsockopt(raw(handle), SOL_SOCKET, SO_EXCLUSIVEADDRUSE, reinterpret_cast<const char*>(&exclusive), sizeof exclusive);
#endif
    if (::bind(raw(handle), reinterpret_cast<const sockaddr*>(&addr), sizeof addr) != 0)
    {
        error = "cannot use UDP " + ipv4 + ":" + std::to_string(port) + ": " + errorText(lastError()) +
                " (port in use by another program, or the address is not on this PC)";
        close();
        return false;
    }
    return true;
}

bool UdpSocket::connectTo(const std::string& ipv4, uint16_t port, std::string& error)
{
    sockaddr_in addr{};
    if (!parseAddress(ipv4, port, addr) || port == 0)
    {
        error = "not an IPv4 address and port: " + ipv4 + ":" + std::to_string(port);
        return false;
    }
    if (!open(error))
    {
        return false;
    }
    if (::connect(raw(handle), reinterpret_cast<const sockaddr*>(&addr), sizeof addr) != 0)
    {
        error = "UDP connect to " + ipv4 + ":" + std::to_string(port) + " failed: " + errorText(lastError());
        close();
        return false;
    }
    return true;
}

long UdpSocket::send_to(const Endpoint& to, const uint8_t* data, size_t size, std::string& error)
{
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(to.port);
    addr.sin_addr.s_addr = htonl(to.ip);
#ifdef _WIN32
    const int n = ::sendto(raw(handle), reinterpret_cast<const char*>(data), static_cast<int>(size), 0,
                           reinterpret_cast<const sockaddr*>(&addr), sizeof addr);
#else
    const ssize_t n = ::sendto(raw(handle), data, size, 0, reinterpret_cast<const sockaddr*>(&addr), sizeof addr);
#endif
    if (n < 0)
    {
        const int e = lastError();
        if (wouldBlock(e))
        {
            return 0;
        }
        error = "sendto " + to.text() + " failed: " + errorText(e);
        return -1;
    }
    return static_cast<long>(n);
}

long UdpSocket::send(const uint8_t* data, size_t size, std::string& error)
{
#ifdef _WIN32
    const int n = ::send(raw(handle), reinterpret_cast<const char*>(data), static_cast<int>(size), 0);
#else
    const ssize_t n = ::send(raw(handle), data, size, 0);
#endif
    if (n < 0)
    {
        const int e = lastError();
        if (wouldBlock(e))
        {
            return 0;
        }
        error = "send failed: " + errorText(e);
        return -1;
    }
    return static_cast<long>(n);
}

long UdpSocket::recv_from(uint8_t* buffer, size_t size, Endpoint& from, std::string& error)
{
    sockaddr_in addr{};
    socklenType len = sizeof addr;
#ifdef _WIN32
    const int n = ::recvfrom(raw(handle), reinterpret_cast<char*>(buffer), static_cast<int>(size), 0,
                             reinterpret_cast<sockaddr*>(&addr), &len);
#else
    const ssize_t n = ::recvfrom(raw(handle), buffer, size, 0, reinterpret_cast<sockaddr*>(&addr), &len);
#endif
    if (n < 0)
    {
        const int e = lastError();
        if (wouldBlock(e))
        {
            return 0;
        }
#ifdef _WIN32
        if (e == WSAEMSGSIZE)
        {
            from.ip = ntohl(addr.sin_addr.s_addr);
            from.port = ntohs(addr.sin_port);
            return -3;
        }
        if (e == WSAECONNRESET)
        {
            return 0;  // stale ICMP report on a connected socket; nothing to read
        }
#else
        if (e == ECONNREFUSED)
        {
            return 0;
        }
#endif
        error = "receive failed: " + errorText(e);
        return -1;
    }
    from.ip = ntohl(addr.sin_addr.s_addr);
    from.port = ntohs(addr.sin_port);
    return static_cast<long>(n);
}

bool UdpSocket::waitReadable(int timeoutMs)
{
    if (!valid())
    {
        return false;
    }
    fd_set set;
    FD_ZERO(&set);
    FD_SET(raw(handle), &set);
    timeval tv{timeoutMs / 1000, (timeoutMs % 1000) * 1000};
    return ::select(static_cast<int>(handle + 1), &set, nullptr, nullptr, &tv) >= 0;
}

Endpoint UdpSocket::localEndpoint() const
{
    Endpoint e;
    if (!valid())
    {
        return e;
    }
    sockaddr_in addr{};
    socklenType len = sizeof addr;
    if (getsockname(raw(handle), reinterpret_cast<sockaddr*>(&addr), &len) == 0)
    {
        e.ip = ntohl(addr.sin_addr.s_addr);
        e.port = ntohs(addr.sin_port);
    }
    return e;
}

