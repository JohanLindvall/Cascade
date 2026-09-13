// Clamp a torrent's path components to what Linux filesystems accept.
//
// Dropped into libtorrent's src/torrent/ by apply-libtorrent.sh and wired into
// the three places that turn names into filesystem paths: Path::as_string()
// (the file itself — what frozen_path and the hash check use),
// FileList::make_directory() (each directory on the way), and
// FileList::set_root_dir() (the root rtorrent composes from the download
// directory and the torrent's name — for a multi-file torrent that name is a
// directory, and it never passes through Path).
//
// Why: NAME_MAX on every mainstream Linux filesystem (ext4, xfs, btrfs, ...)
// is 255 *bytes* per component, and libtorrent opens files under the exact
// name from the torrent's info dictionary. Thai, CJK and emoji are three or
// four bytes a character in UTF-8, so a name of ~85 characters already fails
// with ENAMETOOLONG — surfacing in rtorrent as "Hash check I/O error at chunk
// 0: Filename too long" and a torrent that can never start.
//
// Header-only on purpose: nothing to add to libtorrent's build, and the same
// rule compiles against every release from 0.13.x to 0.16.x.
#ifndef LIBTORRENT_PATH_FIT_H
#define LIBTORRENT_PATH_FIT_H

#include <cstdint>
#include <string>

namespace torrent {

// A single path component may be at most this many bytes.
static const std::string::size_type path_fit_max_bytes = 255;

// 32-bit FNV-1a of the original name, as eight hex digits. Cheap,
// dependency-free, and simple enough to reproduce elsewhere so the shortened
// name can be predicted (Cascade's checks do exactly that).
inline std::string
path_fit_tag(const std::string& s) {
  uint32_t h = 2166136261u;
  for (std::string::const_iterator itr = s.begin(); itr != s.end(); ++itr) {
    h ^= static_cast<unsigned char>(*itr);
    h *= 16777619u;
  }
  static const char hex[] = "0123456789abcdef";
  std::string out(8, '0');
  for (int i = 7; i >= 0; --i) {
    out[i] = hex[h & 0xf];
    h >>= 4;
  }
  return out;
}

// The component unchanged when it fits; otherwise the stem cut at a UTF-8
// character boundary, "~" plus the tag of the original (so two names that
// differ only past the cut cannot land on the same file), and the extension.
inline std::string
path_fit_component(const std::string& name) {
  if (name.size() <= path_fit_max_bytes)
    return name;

  // Keep a short, ordinary extension; a "." deep inside a title is not one.
  std::string ext;
  std::string::size_type dot = name.rfind('.');
  if (dot != std::string::npos && dot > 0 && name.size() - dot <= 16 &&
      name.find_first_of(" \t", dot) == std::string::npos)
    ext = name.substr(dot);

  const std::string tag = "~" + path_fit_tag(name);
  std::string::size_type cut = path_fit_max_bytes - tag.size() - ext.size();

  // Never split a multi-byte character: a continuation byte (10xxxxxx) at
  // the cut means the character started before it, so back off past it.
  while (cut > 0 && (static_cast<unsigned char>(name[cut]) & 0xC0) == 0x80)
    --cut;
  // A stem ending in spaces or dots reads as a typo; drop them.
  while (cut > 0 && (name[cut - 1] == ' ' || name[cut - 1] == '.'))
    --cut;

  return name.substr(0, cut) + tag + ext;
}

// Every component of a whole path clamped the same way, slashes kept exactly
// as they were (leading, trailing, doubled) so the result is the same path
// with only the over-long names changed.
inline std::string
path_fit_path(const std::string& path) {
  std::string out;
  std::string::size_type start = 0;

  for (;;) {
    std::string::size_type slash = path.find('/', start);
    out += path_fit_component(path.substr(start, slash == std::string::npos ? std::string::npos : slash - start));

    if (slash == std::string::npos)
      return out;

    out += '/';
    start = slash + 1;
  }
}

} // namespace torrent

#endif
