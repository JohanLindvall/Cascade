package httpapi

import (
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/http"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
)

// The shape of an upload: .torrent files under "torrents", plus the add
// options and the URL list as fields.
const (
	uploadMaxFiles    = 50
	uploadMaxFields   = 4
	uploadMaxParts    = uploadMaxFiles + uploadMaxFields
	uploadMaxFieldLen = 1 << 20
	uploadMaxNameLen  = 100
)

type uploadedFile struct {
	name string
	data []byte
}

// readUpload reads a multipart upload whole before anything is added, so a
// batch that breaks a limit is refused before a single torrent loads. The
// size limit bounds each file and the batch as a whole — chunked requests
// carry no Content-Length to refuse up front. Fields land in a body map the
// way a JSON body would, a repeated field becoming a list.
func readUpload(r *http.Request, maxBytes int64) ([]uploadedFile, map[string]any, error) {
	reader, err := r.MultipartReader()
	if err != nil {
		return nil, nil, httperr.New(http.StatusBadRequest, "malformed multipart upload: "+err.Error())
	}
	files := []uploadedFile{}
	fields := map[string]any{}
	parts, fieldCount := 0, 0
	var total int64
	for {
		part, err := reader.NextPart()
		if errors.Is(err, io.EOF) {
			return files, fields, nil
		}
		if err != nil {
			return nil, nil, httperr.New(http.StatusBadRequest, "malformed multipart upload: "+err.Error())
		}
		parts++
		if parts > uploadMaxParts {
			return nil, nil, httperr.New(http.StatusRequestEntityTooLarge, "Too many parts")
		}
		name := part.FormName()
		if name == "" {
			return nil, nil, httperr.New(http.StatusBadRequest, "Field name missing")
		}
		if filename, isFile := partFileName(part); isFile {
			if name != "torrents" {
				return nil, nil, httperr.New(http.StatusBadRequest, "Unexpected field")
			}
			if len(files) == uploadMaxFiles {
				return nil, nil, httperr.New(http.StatusRequestEntityTooLarge, "Too many files")
			}
			data, err := io.ReadAll(io.LimitReader(part, maxBytes+1))
			if err != nil {
				return nil, nil, httperr.New(http.StatusBadRequest, "malformed multipart upload: "+err.Error())
			}
			if int64(len(data)) > maxBytes {
				return nil, nil, httperr.New(http.StatusRequestEntityTooLarge, "torrent file exceeds the upload size limit")
			}
			if total += int64(len(data)); total > maxBytes {
				return nil, nil, httperr.Newf(http.StatusRequestEntityTooLarge, "torrent upload batch exceeds %d bytes", maxBytes)
			}
			files = append(files, uploadedFile{name: filename, data: data})
			continue
		}
		if fieldCount++; fieldCount > uploadMaxFields {
			return nil, nil, httperr.New(http.StatusBadRequest, "Too many fields")
		}
		if len(name) > uploadMaxNameLen {
			return nil, nil, httperr.New(http.StatusBadRequest, "Field name too long")
		}
		value, err := io.ReadAll(io.LimitReader(part, uploadMaxFieldLen+1))
		if err != nil {
			return nil, nil, httperr.New(http.StatusBadRequest, "malformed multipart upload: "+err.Error())
		}
		if len(value) > uploadMaxFieldLen {
			return nil, nil, httperr.New(http.StatusRequestEntityTooLarge, "Field value too long")
		}
		switch existing := fields[name].(type) {
		case nil:
			fields[name] = string(value)
		case []any:
			fields[name] = append(existing, string(value))
		default:
			fields[name] = []any{existing, string(value)}
		}
	}
}

// partFileName is the part's file name, and whether it is a file at all: a
// part is one when its disposition names a file, even an empty name.
func partFileName(part *multipart.Part) (string, bool) {
	_, params, err := mime.ParseMediaType(part.Header.Get("Content-Disposition"))
	if err != nil {
		return "", false
	}
	if _, isFile := params["filename"]; !isFile {
		if _, isFile = params["filename*"]; !isFile {
			return "", false
		}
	}
	return part.FileName(), true
}
