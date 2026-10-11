#include "rr/media/opus_codec.hpp"

#include <opus.h>

namespace rr::media {

const char* opus_application_name(OpusApplication a) noexcept {
    return a == OpusApplication::Audio ? "OPUS_APPLICATION_AUDIO" : "OPUS_APPLICATION_RESTRICTED_LOWDELAY";
}

bool is_allowed_frame(std::uint32_t frame_samples) noexcept {
    return frame_samples == 120 || frame_samples == 240 || frame_samples == 480 || frame_samples == 960;
}

double frame_ms(std::uint32_t frame_samples) noexcept {
    return static_cast<double>(frame_samples) * 1000.0 / kLiveSampleRate;
}

std::string validate(const LiveCodecSettings& s) {
    if (!is_allowed_frame(s.frame_samples)) {
        return "frame size " + std::to_string(s.frame_samples) +
               " samples is not allowed (120, 240, 480 or 960 = 2.5, 5, 10 or 20 ms at 48 kHz)";
    }
    if (s.bitrate_bps < kMinBitrate || s.bitrate_bps > kMaxBitrate) {
        return "bitrate " + std::to_string(s.bitrate_bps) + " bit/s is outside 16000..128000";
    }
    if (s.complexity > 10) {
        return "Opus complexity " + std::to_string(s.complexity) + " is outside 0..10";
    }
    return {};
}

std::string validate(const LivePlayoutSettings& s) {
    if (s.target_frames < kMinTargetFrames || s.target_frames > kMaxTargetFrames) {
        return "jitter-buffer target " + std::to_string(s.target_frames) + " frames is outside 1..16";
    }
    if (s.stall_limit < 5 || s.stall_limit > 200) {
        return "stall limit " + std::to_string(s.stall_limit) + " is outside 5..200";
    }
    if (!(s.gain_db >= kMinGainDb && s.gain_db <= kMaxGainDb)) {
        return "live output gain must be within -60..0 dB";
    }
    return {};
}

std::string opus_version() {
    return opus_get_version_string();
}

OpusLiveEncoder::~OpusLiveEncoder() {
    if (enc_ != nullptr) {
        opus_encoder_destroy(enc_);
    }
}

bool OpusLiveEncoder::create(const LiveCodecSettings& settings, std::string& error) {
    error = validate(settings);
    if (!error.empty()) {
        return false;
    }
    if (enc_ != nullptr) {
        opus_encoder_destroy(enc_);
        enc_ = nullptr;
    }
    const int application = settings.application == OpusApplication::Audio ? OPUS_APPLICATION_AUDIO
                                                                            : OPUS_APPLICATION_RESTRICTED_LOWDELAY;
    int rc = OPUS_OK;
    enc_ = opus_encoder_create(static_cast<opus_int32>(kLiveSampleRate), static_cast<int>(kLiveChannels), application, &rc);
    if (rc != OPUS_OK || enc_ == nullptr) {
        error = std::string("opus_encoder_create failed: ") + opus_strerror(rc);
        enc_ = nullptr;
        return false;
    }
    const int checks[] = {
        opus_encoder_ctl(enc_, OPUS_SET_BITRATE(static_cast<opus_int32>(settings.bitrate_bps))),
        opus_encoder_ctl(enc_, OPUS_SET_VBR(settings.constant_bitrate ? 0 : 1)),
        opus_encoder_ctl(enc_, OPUS_SET_COMPLEXITY(static_cast<opus_int32>(settings.complexity))),
        // In-band FEC is a SILK (LPC layer) feature; it stays off (the default). Loss is handled
        // by concealment on the monitor path only.
        opus_encoder_ctl(enc_, OPUS_SET_INBAND_FEC(0)),
    };
    for (const int c : checks) {
        if (c != OPUS_OK) {
            error = std::string("opus_encoder_ctl failed: ") + opus_strerror(c);
            opus_encoder_destroy(enc_);
            enc_ = nullptr;
            return false;
        }
    }
    opus_int32 v = 0;
    opus_encoder_ctl(enc_, OPUS_GET_LOOKAHEAD(&v));
    lookahead_ = v;
    opus_encoder_ctl(enc_, OPUS_GET_BITRATE(&v));
    bitrate_ = v;
    opus_encoder_ctl(enc_, OPUS_GET_COMPLEXITY(&v));
    complexity_ = v;
    settings_ = settings;
    return true;
}

int OpusLiveEncoder::encode(const float* pcm, std::uint8_t* out, std::size_t out_capacity) noexcept {
    if (enc_ == nullptr) {
        return OPUS_INVALID_STATE;
    }
    return opus_encode_float(enc_, pcm, static_cast<int>(settings_.frame_samples), out,
                             static_cast<opus_int32>(out_capacity));
}

void OpusLiveEncoder::reset() noexcept {
    if (enc_ != nullptr) {
        opus_encoder_ctl(enc_, OPUS_RESET_STATE);
    }
}

OpusLiveDecoder::~OpusLiveDecoder() {
    if (dec_ != nullptr) {
        opus_decoder_destroy(dec_);
    }
}

bool OpusLiveDecoder::create(std::string& error) {
    if (dec_ != nullptr) {
        opus_decoder_destroy(dec_);
        dec_ = nullptr;
    }
    int rc = OPUS_OK;
    dec_ = opus_decoder_create(static_cast<opus_int32>(kLiveSampleRate), static_cast<int>(kLiveChannels), &rc);
    if (rc != OPUS_OK || dec_ == nullptr) {
        error = std::string("opus_decoder_create failed: ") + opus_strerror(rc);
        dec_ = nullptr;
        return false;
    }
    return true;
}

int OpusLiveDecoder::decode(const std::uint8_t* packet, std::size_t size, float* pcm, std::uint32_t capacity) noexcept {
    if (dec_ == nullptr) {
        return OPUS_INVALID_STATE;
    }
    return opus_decode_float(dec_, packet, static_cast<opus_int32>(size), pcm, static_cast<int>(capacity), 0);
}

int OpusLiveDecoder::conceal(float* pcm, std::uint32_t frame_samples) noexcept {
    if (dec_ == nullptr) {
        return OPUS_INVALID_STATE;
    }
    // NULL data = packet lost; frame_size must be exactly the missing duration (opus.h).
    return opus_decode_float(dec_, nullptr, 0, pcm, static_cast<int>(frame_samples), 0);
}

void OpusLiveDecoder::reset() noexcept {
    if (dec_ != nullptr) {
        opus_decoder_ctl(dec_, OPUS_RESET_STATE);
    }
}

int OpusLiveDecoder::packet_samples(const std::uint8_t* packet, std::size_t size) noexcept {
    return opus_packet_get_nb_samples(packet, static_cast<opus_int32>(size), static_cast<opus_int32>(kLiveSampleRate));
}

}  // namespace rr::media
