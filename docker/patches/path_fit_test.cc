// Self-test for path_fit.h, compiled and run by apply-libtorrent.sh with the
// same toolchain that then builds libtorrent — so a build with a broken rule
// fails before rtorrent is ever linked, the same contract as the unit tests
// on the TypeScript side.
#include <cstdio>
#include <cstdlib>
#include <string>

#include "path_fit.h"

using torrent::path_fit_component;
using torrent::path_fit_max_bytes;
using torrent::path_fit_path;

static int failures = 0;

#define CHECK(cond)                                                              \
  do {                                                                           \
    if (!(cond)) {                                                               \
      std::fprintf(stderr, "path_fit: FAILED %s (line %d)\n", #cond, __LINE__); \
      failures++;                                                                \
    }                                                                            \
  } while (0)

// Every byte of a UTF-8 string is a lead byte or a continuation of a lead
// byte still inside the string: the cut never split a character.
static bool
valid_utf8(const std::string& s) {
  std::string::size_type i = 0;
  while (i < s.size()) {
    unsigned char c = static_cast<unsigned char>(s[i]);
    std::string::size_type n = c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xE ? 3 : (c >> 3) == 0x1E ? 4 : 0;
    if (n == 0 || i + n > s.size())
      return false;
    for (std::string::size_type k = 1; k < n; ++k)
      if ((static_cast<unsigned char>(s[i + k]) & 0xC0) != 0x80)
        return false;
    i += n;
  }
  return true;
}

static std::string
repeat(const std::string& unit, std::string::size_type times) {
  std::string out;
  for (std::string::size_type i = 0; i < times; ++i)
    out += unit;
  return out;
}

int
main() {
  // What fits is left alone, byte for byte — including the empty component
  // that marks a directory, and a name of exactly the limit.
  CHECK(path_fit_component("") == "");
  CHECK(path_fit_component("Some.Series.S01E01.mkv") == "Some.Series.S01E01.mkv");
  CHECK(path_fit_component(std::string(path_fit_max_bytes, 'a')) == std::string(path_fit_max_bytes, 'a'));

  // The case from the field: a Thai title, three bytes a character.
  const std::string thai = repeat("\xe0\xb8\xab\xe0\xb8\xa5\xe0\xb8\xa7\xe0\xb8\x87", 30) + ".mp4"; // 30 x 4 chars
  CHECK(thai.size() > path_fit_max_bytes);
  const std::string fitted = path_fit_component(thai);
  CHECK(fitted.size() <= path_fit_max_bytes);
  CHECK(fitted.size() > path_fit_max_bytes - 4); // it uses the room it has
  CHECK(valid_utf8(fitted));
  CHECK(fitted.compare(fitted.size() - 4, 4, ".mp4") == 0);
  CHECK(fitted.find('~') != std::string::npos);
  CHECK(fitted.compare(0, 3, "\xe0\xb8\xab") == 0); // the stem is the original's start
  CHECK(path_fit_component(thai) == fitted);           // deterministic

  // Two names that differ only past the cut must not collide.
  const std::string a = std::string(300, 'x') + "A.bin";
  const std::string b = std::string(300, 'x') + "B.bin";
  CHECK(path_fit_component(a) != path_fit_component(b));
  CHECK(path_fit_component(a).size() <= path_fit_max_bytes);

  // A long "extension" is not one; a real one survives; four-byte emoji cut cleanly.
  const std::string no_ext = std::string(300, 'y') + "." + std::string(40, 'z');
  CHECK(path_fit_component(no_ext).compare(path_fit_component(no_ext).size() - 1, 1, "z") != 0);
  const std::string emoji = repeat("\xf0\x9f\x8e\xb5", 80) + ".flac"; // 320 bytes of notes
  CHECK(valid_utf8(path_fit_component(emoji)));
  CHECK(path_fit_component(emoji).size() <= path_fit_max_bytes);
  CHECK(path_fit_component(emoji).compare(path_fit_component(emoji).size() - 5, 5, ".flac") == 0);

  // A stem that would end in a space or dot is trimmed to the last real character.
  const std::string spaced = std::string(240, 'w') + std::string(30, ' ') + "tail.mkv";
  const std::string spaced_fit = path_fit_component(spaced);
  CHECK(spaced_fit.find(" ~") == std::string::npos);

  // Whole paths: only the over-long components change, slashes stay put.
  CHECK(path_fit_path("") == "");
  CHECK(path_fit_path("/downloads") == "/downloads");
  CHECK(path_fit_path("/downloads/") == "/downloads/");
  CHECK(path_fit_path("a//b") == "a//b");
  const std::string root = "/downloads/" + thai + "/sub";
  const std::string root_fit = path_fit_path(root);
  CHECK(root_fit == "/downloads/" + fitted + "/sub");
  CHECK(root_fit.compare(0, 11, "/downloads/") == 0);
  CHECK(root_fit.compare(root_fit.size() - 4, 4, "/sub") == 0);

  if (failures) {
    std::fprintf(stderr, "path_fit: %d check(s) failed\n", failures);
    return EXIT_FAILURE;
  }
  std::printf("path_fit: self-test passed (%zu-byte components)\n", (size_t) path_fit_max_bytes);
  return EXIT_SUCCESS;
}
