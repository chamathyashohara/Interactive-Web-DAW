#include "xconn.hpp"

#include <algorithm>

#include "rr/shared/clock.hpp"

namespace rr::xfer::detail {

bool XConn::pump(int timeout_ms, std::deque<XMsg>& in) {
    if (!sock_.valid() || failed_) {
        if (error_.empty()) {
            error_ = "not connected";
        }
        return false;
    }
    std::vector<net::TcpSocket*> rd;
    std::vector<net::TcpSocket*> wr;
    if (dec_.can_accept_more()) {
        rd.push_back(&sock_);
    }
    if (pending_out() > 0) {
        wr.push_back(&sock_);
    }
    if (!net::TcpSocket::wait(rd, wr, timeout_ms)) {
        failed_ = true;
        error_ = "select failed";
        return false;
    }
    std::string err;
    // Write as much as the socket takes.
    while (pending_out() > 0) {
        const long n = sock_.send_some(out_.data() + out_off_, pending_out(), err);
        if (n < 0) {
            failed_ = true;
            error_ = err;  // already says "send failed: ..."
            return false;
        }
        if (n == 0) {
            break;
        }
        out_off_ += static_cast<std::size_t>(n);
    }
    if (out_off_ == out_.size()) {
        out_.clear();
        out_off_ = 0;
    } else if (out_off_ > (1u << 20)) {
        out_.erase(out_.begin(), out_.begin() + static_cast<std::ptrdiff_t>(out_off_));
        out_off_ = 0;
    }
    // Read what is waiting (bounded by the decoder's limit).
    std::uint8_t buf[65536];
    while (dec_.can_accept_more()) {
        // Never read past the decoder's bound (it rejects a stream that overfills it).
        const std::size_t room = std::min(sizeof buf, dec_.room());
        const long n = sock_.recv_some(buf, room, err);
        if (n == -2) {
            // Orderly close: deliver whatever complete messages arrived first.
            failed_ = true;
            error_ = "the other side closed the connection";
            break;
        }
        if (n < 0) {
            failed_ = true;
            error_ = err;  // already says "receive failed: ..."
            break;
        }
        if (n == 0) {
            break;
        }
        dec_.feed(buf, static_cast<std::size_t>(n));
    }
    for (;;) {
        XMsg m;
        std::string derr;
        const auto r = dec_.next(m, derr);
        if (r == XDecoder::Result::NeedMore) {
            break;
        }
        if (r == XDecoder::Result::Error) {
            failed_ = true;
            error_ = "protocol error: " + derr;
            return false;
        }
        in.push_back(std::move(m));
    }
    return !failed_;
}

void XConn::close_after_flush(int max_ms) {
    const std::int64_t until = time::monotonic_ns() + static_cast<std::int64_t>(max_ms) * 1000000;
    std::deque<XMsg> ignored;
    while (valid() && pending_out() > 0 && time::monotonic_ns() < until) {
        if (!pump(10, ignored)) {
            break;
        }
    }
    sock_.shutdown_send();
    // Drain until the peer closes (bounded): closing with unread data would send a reset that
    // can discard the last message (an ABORT or RESULT) before the peer reads it.
    const std::int64_t drain_until = time::monotonic_ns() + 300 * 1000000LL;
    std::uint8_t buf[4096];
    std::string err;
    while (sock_.valid() && time::monotonic_ns() < drain_until) {
        std::vector<net::TcpSocket*> rd{&sock_};
        net::TcpSocket::wait(rd, {}, 20);
        const long n = sock_.recv_some(buf, sizeof buf, err);
        if (n < 0) {
            break;  // closed (-2) or error
        }
    }
    close();
}

}  // namespace rr::xfer::detail
