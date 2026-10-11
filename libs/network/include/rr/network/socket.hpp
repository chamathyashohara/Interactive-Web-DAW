#pragma once

// Minimal TCP socket layer for the control channel (ADR-016): IPv4 only, non-blocking
// sockets driven by select() on one control thread. Winsock on Windows, BSD sockets elsewhere.
// UdpSocket (Stage 7, ADR-017) carries the live media.

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace rr::net {

// Call once per process before using sockets (WSAStartup on Windows). Thread-safe, idempotent.
bool init_sockets(std::string& error);

struct NetInterface {
    std::string name;     // adapter name as shown by Windows ("Wi-Fi 2")
    std::string address;  // dotted IPv4
    bool loopback = false;
    bool private_lan = false;  // RFC 1918 or link-local
};

// IPv4 addresses of this PC (loopback last). Empty on failure.
std::vector<NetInterface> list_ipv4_interfaces();

bool is_valid_ipv4(const std::string& text) noexcept;

class TcpSocket {
public:
    TcpSocket() = default;
    ~TcpSocket();
    TcpSocket(TcpSocket&& other) noexcept;
    TcpSocket& operator=(TcpSocket&& other) noexcept;
    TcpSocket(const TcpSocket&) = delete;
    TcpSocket& operator=(const TcpSocket&) = delete;

    // Server: bind to one explicit IPv4 address (never all interfaces implicitly) and listen.
    bool listen_on(const std::string& ipv4, std::uint16_t port, std::string& error);
    // Returns an invalid socket when no connection is pending (non-blocking).
    TcpSocket accept_pending(std::string& peer_address, std::string& error);

    // Client: starts a non-blocking connect; poll with connect_finished().
    bool connect_start(const std::string& ipv4, std::uint16_t port, std::string& error);
    // 1 = connected, 0 = still connecting, -1 = failed (error set).
    int connect_finished(std::string& error);

    // Non-blocking I/O. send_some returns bytes written (0 if it would block, -1 on error).
    long send_some(const std::uint8_t* data, std::size_t size, std::string& error);
    // Returns bytes read, 0 if nothing available, -1 on error, -2 on orderly close by the peer.
    long recv_some(std::uint8_t* buffer, std::size_t size, std::string& error);

    bool valid() const noexcept;
    void close() noexcept;
    // Graceful half-close: no more sends; queued data is still delivered (avoids the reset
    // that an immediate close() sends when unread data is pending, which would discard it).
    void shutdown_send() noexcept;
    std::intptr_t native() const noexcept { return handle_; }

    // Waits until any socket is readable/writable (or timeout). Returns false on error.
    static bool wait(const std::vector<TcpSocket*>& read, const std::vector<TcpSocket*>& write, int timeout_ms);
    static bool is_readable(const TcpSocket& s);
    static bool is_writable(const TcpSocket& s);

private:
    explicit TcpSocket(std::intptr_t handle) : handle_(handle) {}
    std::intptr_t handle_ = -1;
};

// IPv4 address and port in host byte order (live media, ADR-017).
struct Endpoint {
    std::uint32_t ip = 0;
    std::uint16_t port = 0;
    bool valid() const noexcept { return ip != 0 && port != 0; }
    std::string text() const;  // "192.168.1.5:52001"
};
inline bool operator==(const Endpoint& a, const Endpoint& b) noexcept { return a.ip == b.ip && a.port == b.port; }
inline bool operator!=(const Endpoint& a, const Endpoint& b) noexcept { return !(a == b); }
bool parse_endpoint(const std::string& ipv4, std::uint16_t port, Endpoint& out) noexcept;
std::string ipv4_text(std::uint32_t ip);

// Minimal non-blocking UDP socket for the live media path (ADR-017). IPv4 only.
//  - producer: bind_on() one explicitly selected interface (0.0.0.0 is refused), like the
//    control listener (ADR-016);
//  - performer: connect_to() the producer's media endpoint, so the kernel delivers only that
//    endpoint's datagrams, and replies pass a stateful firewall without an inbound rule.
// On Windows, ICMP "port unreachable" reports are disabled (SIO_UDP_CONNRESET), otherwise one
// unreachable peer makes every later recvfrom() fail with WSAECONNRESET.
class UdpSocket {
public:
    static constexpr std::size_t kMaxDatagram = 2048;  // receive buffer; larger datagrams are reported as oversized

    UdpSocket() = default;
    ~UdpSocket();
    UdpSocket(const UdpSocket&) = delete;
    UdpSocket& operator=(const UdpSocket&) = delete;

    bool bind_on(const std::string& ipv4, std::uint16_t port, std::string& error);
    bool connect_to(const std::string& ipv4, std::uint16_t port, std::string& error);

    // Returns bytes sent, 0 if it would block, -1 on error.
    long send_to(const Endpoint& to, const std::uint8_t* data, std::size_t size, std::string& error);
    long send(const std::uint8_t* data, std::size_t size, std::string& error);  // connected socket only
    // Returns bytes received (the datagram), 0 if none is waiting, -1 on error,
    // -3 if the datagram was larger than the buffer (it is discarded).
    long recv_from(std::uint8_t* buffer, std::size_t size, Endpoint& from, std::string& error);

    // Waits until a datagram is waiting or the timeout passes. False on error.
    bool wait_readable(int timeout_ms);
    Endpoint local_endpoint() const;
    bool valid() const noexcept;
    void close() noexcept;

private:
    bool open(std::string& error);
    std::intptr_t handle_ = -1;
};

}  // namespace rr::net
