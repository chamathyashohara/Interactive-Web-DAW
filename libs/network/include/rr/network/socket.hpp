#pragma once

// Minimal TCP socket layer for the control channel (ADR-016): IPv4 only, non-blocking
// sockets driven by select() on one control thread. Winsock on Windows, BSD sockets elsewhere.

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

}  // namespace rr::net
