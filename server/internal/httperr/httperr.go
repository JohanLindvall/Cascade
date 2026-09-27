// Package httperr gives an error the HTTP status it should reach the client
// with, so a refusal deep in the service surfaces as a status that means
// something rather than a bare 500.
package httperr

import "fmt"

// Error is an error with an HTTP status, surfaced to the client verbatim.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return e.Message }

// New returns an Error with the status and message.
func New(status int, message string) *Error {
	return &Error{Status: status, Message: message}
}

// Newf returns an Error with the status and a formatted message.
func Newf(status int, format string, args ...any) *Error {
	return &Error{Status: status, Message: fmt.Sprintf(format, args...)}
}

// Backend is an unavailable backend or a malformed upstream reply: a 502.
func Backend(message string) *Error {
	return &Error{Status: 502, Message: message}
}
