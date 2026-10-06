// SPDX-License-Identifier: MIT

package store

import (
	"regexp"

	"github.com/JohanLindvall/Cascade/server/internal/contracts"
	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
)

// ThrottleName is what a throttle group may be called; NULL and URL dot
// segments are refused too.
var ThrottleName = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,32}$`)

// NormalizeThrottle validates a group and rounds its rates to what rtorrent
// can hold. Its group setters take whole KiB/s, unlike the global setters'
// bytes/s, so a rate is rounded up to the next KiB — up, so a positive
// sub-KiB limit never becomes 0, which rtorrent reads as unlimited.
func NormalizeThrottle(group contracts.ThrottleGroup) (contracts.ThrottleGroup, error) {
	return normalizeThrottle(group.Name, group.Up, group.Down)
}

// normalizeThrottle takes the rates as values so that a persisted group,
// whose numbers are whatever the file held, is checked the same way.
func normalizeThrottle(name string, up, down any) (contracts.ThrottleGroup, error) {
	if !ThrottleName.MatchString(name) || name == "NULL" || name == "." || name == ".." {
		return contracts.ThrottleGroup{}, httperr.New(400, "throttle name must be 1-32 chars of [A-Za-z0-9_.-] and cannot be NULL, . or ..")
	}
	upRate, err := wholeKiB(up, "up")
	if err != nil {
		return contracts.ThrottleGroup{}, err
	}
	downRate, err := wholeKiB(down, "down")
	if err != nil {
		return contracts.ThrottleGroup{}, err
	}
	return contracts.ThrottleGroup{Name: name, Up: upRate, Down: downRate}, nil
}

func wholeKiB(value any, field string) (int64, error) {
	rate, err := validate.Int(value, field, 0, validate.MaxSafeInteger-1023)
	if err != nil {
		return 0, err
	}
	return (rate + 1023) / 1024 * 1024, nil
}
