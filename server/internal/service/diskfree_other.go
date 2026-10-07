// SPDX-License-Identifier: MIT

//go:build !unix

package service

// freeSpace cannot be determined here.
func freeSpace(string) *int64 { return nil }
