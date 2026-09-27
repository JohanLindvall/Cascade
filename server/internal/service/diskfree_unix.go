//go:build unix

package service

import "syscall"

// freeSpace is the free space on the download volume, or nil where it cannot
// be determined.
func freeSpace(dir string) *int64 {
	var stats syscall.Statfs_t
	if err := syscall.Statfs(dir, &stats); err != nil {
		return nil
	}
	free := int64(stats.Bavail) * int64(stats.Bsize)
	return &free
}
