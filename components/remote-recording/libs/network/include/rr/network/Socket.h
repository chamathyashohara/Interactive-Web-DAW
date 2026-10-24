#pragma once

// Minimal TCP socket layer for the control channel (ADR-016): IPv4 only, non-blocking
// sockets driven by select() on one control thread. Winsock on Windows, BSD sockets elsewhere.
// UdpSocket (Stage 7, ADR-017) carries the live media.

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

/** Call once per process before using sockets (WSAStartup on Windows). Thread-safe, idempotent. */
bool initSockets(std::string& error);

struct NetInterface
{
    std::string name;     // adapter name as shown by Windows ("Wi-Fi 2")
    std::string address;  // dotted IPv4
    bool loopback = false;
    bool privateLan = false;  // RFC 1918 or link-local
};

/** IPv4 addresses of this PC (loopback last). Empty on failure. */
std::vector<NetInterface> listIpv4Interfaces();

bool isValidIpv4(const std::string& text) noexcept;

class TcpSocket
{
public:
    TcpSocket() = default;
    ~TcpSocket();
    TcpSocket(TcpSocket&& other) noexcept;
    TcpSocket& operator=(TcpSocket&& other) noexcept;
    TcpSocket(const TcpSocket&) = delete;
    TcpSocket& operator=(const TcpSocket&) = delete;

    /** Server: bind to one explicit IPv4 address (never all interfaces implicitly) and listen. */
    bool listenOn(const std::string& ipv4, uint16_t port, std::string& error);
    /** Returns an invalid socket when no connection is pending (non-blocking). */
    TcpSocket acceptPending(std::string& peerAddress, std::string& error);

    /** Client: starts a non-blocking connect; poll with connectFinished(). */
    bool connectStart(const std::string& ipv4, uint16_t port, std::string& error);
    /** 1 = connected, 0 = still connecting, -1 = failed (error set). */
    int connectFinished(std::string& error);

    /** Non-blocking I/O. sendSome returns bytes written (0 if it would block, -1 on error). */
    long sendSome(const uint8_t* data, size_t size, std::string& error);
    /** Returns bytes read, 0 if nothing available, -1 on error, -2 on orderly close by the peer. */
    long recvSome(uint8_t* buffer, size_t size, std::string& error);

    bool valid() const noexcept;
    void close() noexcept;
    /**
     * Graceful half-close: no more sends; queued data is still delivered (avoids the reset
     * that an immediate close() sends when unread data is pending, which would discard it).
     */
    void shutdownSend() noexcept;
    intptr_t native() const noexcept { return handle; }

    /** Waits until any socket is readable/writable (or timeout). Returns false on error. */
    static bool wait(const std::vector<TcpSocket*>& read, const std::vector<TcpSocket*>& write, int timeoutMs);
    static bool isReadable(const TcpSocket& s);
    static bool isWritable(const TcpSocket& s);

private:
    explicit TcpSocket(intptr_t handle) : handle(handle) {}
    intptr_t handle = -1;
};

/** IPv4 address and port in host byte order (live media, ADR-017). */
struct Endpoint
{
    uint32_t ip = 0;
    uint16_t port = 0;
    bool valid() const noexcept { return ip != 0 && port != 0; }
    std::string text() const;  // "192.168.1.5:52001"
};
inline bool operator==(const Endpoint& a, const Endpoint& b) noexcept { return a.ip == b.ip && a.port == b.port; }
inline bool operator!=(const Endpoint& a, const Endpoint& b) noexcept { return !(a == b); }
bool parseEndpoint(const std::string& ipv4, uint16_t port, Endpoint& out) noexcept;
std::string ipv4Text(uint32_t ip);

/**
 * Minimal non-blocking UDP socket for the live media path (ADR-017). IPv4 only.
 * - producer: bindOn() one explicitly selected interface (0.0.0.0 is refused), like the
 * control listener (ADR-016);
 * - performer: connectTo() the producer's media endpoint, so the kernel delivers only that
 * endpoint's datagrams, and replies pass a stateful firewall without an inbound rule.
 * On Windows, ICMP "port unreachable" reports are disabled (SIO_UDP_CONNRESET), otherwise one
 * unreachable peer makes every later recvfrom() fail with WSAECONNRESET.
 */
class UdpSocket
{
public:
    static constexpr size_t kMaxDatagram = 2048;  // receive buffer; larger datagrams are reported as oversized

    UdpSocket() = default;
    ~UdpSocket();
    UdpSocket(const UdpSocket&) = delete;
    UdpSocket& operator=(const UdpSocket&) = delete;

    bool bindOn(const std::string& ipv4, uint16_t port, std::string& error);
    bool connectTo(const std::string& ipv4, uint16_t port, std::string& error);

    /** Returns bytes sent, 0 if it would block, -1 on error. */
    long send_to(const Endpoint& to, const uint8_t* data, size_t size, std::string& error);
    long send(const uint8_t* data, size_t size, std::string& error);  // connected socket only
    /**
     * Returns bytes received (the datagram), 0 if none is waiting, -1 on error,
     * -3 if the datagram was larger than the buffer (it is discarded).
     */
    long recv_from(uint8_t* buffer, size_t size, Endpoint& from, std::string& error);

    /** Waits until a datagram is waiting or the timeout passes. False on error. */
    bool waitReadable(int timeoutMs);
    Endpoint localEndpoint() const;
    bool valid() const noexcept;
    void close() noexcept;

private:
    bool open(std::string& error);
    intptr_t handle = -1;
};

