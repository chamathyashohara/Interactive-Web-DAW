"""Lexical sanity check for C/C++ sources (standard library only).

Finds string or character literals that are not closed on the same line, which is how a
mangled "\\n" escape shows up. This matters because the Qt code in libs/ui_common cannot be
compiled on the development PC (no Qt installed), so a broken literal would otherwise only be
caught by the first MSVC build.

Understands // and /* */ comments, "..." and '...' literals with backslash escapes, and
C++11 raw strings R"delim(...)delim". Exit code 1 if any problem is found.

usage: python check_sources.py <dir> [<dir> ...]
"""
import pathlib
import re
import sys

EXTENSIONS = {".c", ".cpp", ".h", ".hpp"}
RAW_START = re.compile(r'(?:u8|u|U|L)?R"([^()\\ ]{0,16})\(')


def is_digit_separator(text, i):
    """True if the ' at text[i] sits inside a numeric literal (token starting with a digit)."""
    if i == 0 or i + 1 >= len(text) or not text[i + 1].isalnum():
        return False
    j = i - 1
    while j >= 0 and (text[j].isalnum() or text[j] in "'._"):
        j -= 1
    token_start = j + 1
    return token_start < i and text[token_start].isdigit()


def check(path):
    text = path.read_text(encoding="utf-8")
    problems = []
    i, n, line = 0, len(text), 1
    while i < n:
        c = text[i]
        if c == "\n":
            line += 1
            i += 1
        elif text.startswith("//", i):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            if j < 0:
                problems.append((line, "unterminated block comment"))
                break
            line += text.count("\n", i, j)
            i = j + 2
        else:
            raw = RAW_START.match(text, i) if c in 'uULR' else None
            if raw:
                end = ")" + raw.group(1) + '"'
                j = text.find(end, raw.end())
                if j < 0:
                    problems.append((line, "unterminated raw string"))
                    break
                line += text.count("\n", i, j)
                i = j + len(end)
            elif c == "'" and is_digit_separator(text, i):
                i += 1  # C++14 digit separator, e.g. 1'000'000
            elif c in "\"'":
                quote, start_line, j = c, line, i + 1
                while j < n and text[j] != quote:
                    if text[j] == "\\":
                        j += 2
                        continue
                    if text[j] == "\n":
                        break
                    j += 1
                if j >= n or text[j] != quote:
                    problems.append((start_line, f"{'string' if quote == chr(34) else 'character'} literal not closed on its line"))
                i = j + 1
            else:
                i += 1
    return problems


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    total, files = 0, 0
    for root in argv[1:]:
        for path in sorted(pathlib.Path(root).rglob("*")):
            if path.suffix in EXTENSIONS and path.is_file():
                files += 1
                for line, message in check(path):
                    print(f"{path}:{line}: {message}")
                    total += 1
    print(f"checked {files} files: {total} problem(s)")
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
