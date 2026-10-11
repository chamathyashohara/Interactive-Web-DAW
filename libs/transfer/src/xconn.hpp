#pragma once

// Internal: one RRXF connection (non-blocking TcpSocket + bounded output buffer + decoder).

#include <cstdint>
#include <deque>
#include <string>
#include <vector>

#include "rr/network/socket.hpp"
#include "rr/transfer/transfer_protocol.hpp"

namespace rr::xfer::detail {

class XConn {
public:
    XConn() = default;
    explicit XConn(net::TcpSocket s) : sock_(std::move(s)) {}

    bool valid() const { return sock_.valid() && !failed_; }
    net::TcpSocket& socket() { return sock_; }
    void reset(net::TcpSocket s) {
        sock_ = std::move(s);
        out_.clear();
        out_off_ = 0;
        dec_ = XDecoder{};
        failed_ = false;
        error_.clear();
    }
    void close() {
        sock_.close();
        out_.clear();
        out_off_ = 0;
    }
    // Graceful: flush what is queued (best effort, bounded wait), then close.
    void close_after_flush(int max_ms);

    void send(const XMsg& m) {
        const auto b = encode(m);
        out_.insert(out_.end(), b.begin(), b.end());
    }
    std::size_t pending_out() const { return out_.size() - out_off_; }

    // Waits up to timeout_ms for I/O, moves bytes both ways, appends decoded messages to `in`.
    // Returns false when the connection is finished (error, protocol error or peer close);
    // error() then explains.
    bool pump(int timeout_ms, std::deque<XMsg>& in);
    const std::string& error() const { return error_; }

private:
    net::TcpSocket sock_;
    std::vector<std::uint8_t> out_;
    std::size_t out_off_ = 0;
    XDecoder dec_;
    bool failed_ = false;
    std::string error_;
};

}  // namespace rr::xfer::detail
