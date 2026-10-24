/* Stage 9: asks Windows (MCI waveaudio, an OS decoder independent of this project's code) to open
 * WAV files and report length and format. Nothing is played. MCI rejects long paths: run it from a
 * short directory and pass short
 * relative names. Build: gcc -O2 MciOpenCheck.c -o mci_open_check.exe -lwinmm */
#include <windows.h>
#include <stdio.h>
int main(int argc, char** argv)
{
    int rc = 0;
    for (int i = 1; i < argc; ++i)
    {
        char cmd[1024], out[256] = {0}, fmt[256] = {0}, ch[64] = {0}, rate[64] = {0};
        snprintf(cmd, sizeof cmd, "open \"%s\" type waveaudio alias t", argv[i]);
        MCIERROR e = mciSendStringA(cmd, NULL, 0, NULL);
        if (e) { char err[256]; mciGetErrorStringA(e, err, sizeof err); printf("%s: Windows MCI could NOT open: %s\n", argv[i], err); rc = 1; continue; }
        mciSendStringA("set t time format ms", NULL, 0, NULL);
        mciSendStringA("status t length", out, sizeof out, NULL);
        mciSendStringA("status t format tag", fmt, sizeof fmt, NULL);
        mciSendStringA("status t channels", ch, sizeof ch, NULL);
        mciSendStringA("status t samplespersec", rate, sizeof rate, NULL);
        printf("%s: Windows MCI opened it: length %s ms, format tag %s, %s ch, %s Hz\n", argv[i], out, fmt, ch, rate);
        mciSendStringA("close t", NULL, 0, NULL);
    }
    return rc;
}
