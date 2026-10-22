#include "rr/media/OpusCodec.h"

#include <opus.h>

const char* opus_application_name(OpusApplication a) noexcept
{
    return a == OpusApplication::Audio ? "OPUS_APPLICATION_AUDIO" : "OPUS_APPLICATION_RESTRICTED_LOWDELAY";
}

bool isAllowedFrame(uint32_t frameSamples) noexcept
{
    return frameSamples == 120 || frameSamples == 240 || frameSamples == 480 || frameSamples == 960;
}

double frameMs(uint32_t frameSamples) noexcept
{
    return static_cast<double>(frameSamples) * 1000.0 / kLiveSampleRate;
}

std::string validate(const LiveCodecSettings& s)
{
    if (!isAllowedFrame(s.frameSamples))
    {
        return "frame size " + std::to_string(s.frameSamples) +
               " samples is not allowed (120, 240, 480 or 960 = 2.5, 5, 10 or 20 ms at 48 kHz)";
    }
    if (s.bitrateBps < kMinBitrate || s.bitrateBps > kMaxBitrate)
    {
        return "bitrate " + std::to_string(s.bitrateBps) + " bit/s is outside 16000..128000";
    }
    if (s.complexity > 10)
    {
        return "Opus complexity " + std::to_string(s.complexity) + " is outside 0..10";
    }
    return {};
}

std::string validate(const LivePlayoutSettings& s)
{
    if (s.targetFrames < kMinTargetFrames || s.targetFrames > kMaxTargetFrames)
    {
        return "jitter-buffer target " + std::to_string(s.targetFrames) + " frames is outside 1..16";
    }
    if (s.stallLimit < 5 || s.stallLimit > 200)
    {
        return "stall limit " + std::to_string(s.stallLimit) + " is outside 5..200";
    }
    if (!(s.gainDb >= kMinGainDb && s.gainDb <= kMaxGainDb))
    {
        return "live output gain must be within -60..0 dB";
    }
    return {};
}

std::string opus_version()
{
    return opus_get_version_string();
}

OpusLiveEncoder::~OpusLiveEncoder()
{
    if (enc != nullptr)
    {
        opus_encoder_destroy(enc);
    }
}

bool OpusLiveEncoder::create(const LiveCodecSettings& s, std::string& error)
{
    error = validate(s);
    if (!error.empty())
    {
        return false;
    }
    if (enc != nullptr)
    {
        opus_encoder_destroy(enc);
        enc = nullptr;
    }
    const int application = s.application == OpusApplication::Audio ? OPUS_APPLICATION_AUDIO
                                                                            : OPUS_APPLICATION_RESTRICTED_LOWDELAY;
    int rc = OPUS_OK;
    enc = opus_encoder_create(static_cast<opus_int32>(kLiveSampleRate), static_cast<int>(kLiveChannels), application, &rc);
    if (rc != OPUS_OK || enc == nullptr)
    {
        error = std::string("opus_encoder_create failed: ") + opus_strerror(rc);
        enc = nullptr;
        return false;
    }
    const int checks[] = {
        opus_encoder_ctl(enc, OPUS_SET_BITRATE(static_cast<opus_int32>(s.bitrateBps))),
        opus_encoder_ctl(enc, OPUS_SET_VBR(s.constantBitrate ? 0 : 1)),
        opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(static_cast<opus_int32>(s.complexity))),
        // In-band FEC is a SILK (LPC layer) feature; it stays off (the default). Loss is handled
        // by concealment on the monitor path only.
        opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(0)),
    };
    for (const int c : checks)
    {
        if (c != OPUS_OK)
        {
            error = std::string("opus_encoder_ctl failed: ") + opus_strerror(c);
            opus_encoder_destroy(enc);
            enc = nullptr;
            return false;
        }
    }
    opus_int32 v = 0;
    opus_encoder_ctl(enc, OPUS_GET_LOOKAHEAD(&v));
    lookahead = v;
    opus_encoder_ctl(enc, OPUS_GET_BITRATE(&v));
    bitrate = v;
    opus_encoder_ctl(enc, OPUS_GET_COMPLEXITY(&v));
    complexity = v;
    settings = s;
    return true;
}

int OpusLiveEncoder::encode(const float* pcm, uint8_t* out, size_t outCapacity) noexcept
{
    if (enc == nullptr)
    {
        return OPUS_INVALID_STATE;
    }
    return opus_encode_float(enc, pcm, static_cast<int>(settings.frameSamples), out,
                             static_cast<opus_int32>(outCapacity));
}

void OpusLiveEncoder::reset() noexcept
{
    if (enc != nullptr)
    {
        opus_encoder_ctl(enc, OPUS_RESET_STATE);
    }
}

OpusLiveDecoder::~OpusLiveDecoder()
{
    if (dec != nullptr)
    {
        opus_decoder_destroy(dec);
    }
}

bool OpusLiveDecoder::create(std::string& error)
{
    if (dec != nullptr)
    {
        opus_decoder_destroy(dec);
        dec = nullptr;
    }
    int rc = OPUS_OK;
    dec = opus_decoder_create(static_cast<opus_int32>(kLiveSampleRate), static_cast<int>(kLiveChannels), &rc);
    if (rc != OPUS_OK || dec == nullptr)
    {
        error = std::string("opus_decoder_create failed: ") + opus_strerror(rc);
        dec = nullptr;
        return false;
    }
    return true;
}

int OpusLiveDecoder::decode(const uint8_t* packet, size_t size, float* pcm, uint32_t capacity) noexcept
{
    if (dec == nullptr)
    {
        return OPUS_INVALID_STATE;
    }
    return opus_decode_float(dec, packet, static_cast<opus_int32>(size), pcm, static_cast<int>(capacity), 0);
}

int OpusLiveDecoder::conceal(float* pcm, uint32_t frameSamples) noexcept
{
    if (dec == nullptr)
    {
        return OPUS_INVALID_STATE;
    }
    // NULL data = packet lost; frame_size must be exactly the missing duration (opus.h).
    return opus_decode_float(dec, nullptr, 0, pcm, static_cast<int>(frameSamples), 0);
}

void OpusLiveDecoder::reset() noexcept
{
    if (dec != nullptr)
    {
        opus_decoder_ctl(dec, OPUS_RESET_STATE);
    }
}

int OpusLiveDecoder::packetSamples(const uint8_t* packet, size_t size) noexcept
{
    return opus_packet_get_nb_samples(packet, static_cast<opus_int32>(size), static_cast<opus_int32>(kLiveSampleRate));
}

