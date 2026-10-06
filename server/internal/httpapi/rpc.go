// SPDX-License-Identifier: MIT

package httpapi

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"

	"github.com/JohanLindvall/Cascade/server/internal/httperr"
	"github.com/JohanLindvall/Cascade/server/internal/rtorrent"
	"github.com/JohanLindvall/Cascade/server/internal/validate"
	"github.com/JohanLindvall/Cascade/server/internal/xmlrpc"
)

// Raw RPC — the API console and /RPC2 — reaches every rtorrent command,
// execute included, so all of it is behind CASCADE_ALLOW_RAW_RPC.

var errRawRPCDisabled = httperr.New(http.StatusForbidden, "raw RPC access is disabled")

// rawRPC guards a raw RPC route.
func (s *Server) rawRPC(next func(c *call) (any, error)) func(c *call) (any, error) {
	return func(c *call) (any, error) {
		if !s.cfg.AllowRawRPC {
			return nil, errRawRPCDisabled
		}
		return next(c)
	}
}

// rpcCall is POST /api/rpc: one command, its answer as JSON. A fault is an
// answer here, not a failure — the console shows it.
func (s *Server) rpcCall(c *call) (any, error) {
	method, err := c.text("method", false)
	if err != nil {
		return nil, err
	}
	value, present := c.field("params")
	params, err := rpcParams(value, present)
	if err != nil {
		return nil, err
	}
	result, err := s.svc.Client().Call(c.ctx, method, params...)
	var fault *xmlrpc.Fault
	if errors.As(err, &fault) {
		type faultBody struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		}
		return struct {
			OK    bool      `json:"ok"`
			Fault faultBody `json:"fault"`
		}{false, faultBody{fault.Code, fault.Message}}, nil
	}
	if err != nil {
		return nil, err
	}
	return struct {
		OK     bool `json:"ok"`
		Result any  `json:"result"`
	}{true, jsonSafe(result)}, nil
}

// rpcHelp is POST /api/rpc/help: what rtorrent says about one command.
func (s *Server) rpcHelp(c *call) (any, error) {
	method, err := c.text("method", false)
	if err != nil {
		return nil, err
	}
	results, err := s.svc.Client().MulticallSettled(c.ctx, []rtorrent.Call{
		{Method: "system.methodHelp", Params: []any{method}},
		{Method: "system.methodSignature", Params: []any{method}},
	})
	if err != nil {
		return nil, err
	}
	answer := struct {
		Method    string `json:"method"`
		Help      string `json:"help"`
		Signature any    `json:"signature"`
	}{Method: method, Signature: ""}
	if results[0].Err == nil {
		answer.Help = rtorrent.Text(results[0].Value)
	}
	if results[1].Err == nil {
		answer.Signature = jsonSafe(results[1].Value)
	}
	return answer, nil
}

// rpcProxy is POST /RPC2, the raw XML-RPC passthrough, so external clients
// (the *arr apps, scripts) can drive rtorrent over HTTP. A JSON body of
// {"method": ..., "params": [...]} is accepted too.
func (s *Server) rpcProxy(w http.ResponseWriter, r *http.Request) {
	payload, err := s.rpcPayload(r)
	var response []byte
	if err == nil {
		// Detached like every change through the API (see api): the command
		// may be a d.erase or a load, and one dropped while it waited for a
		// connection because the client timed out, or the server began to
		// shut down, would never reach rtorrent. The SCGI timeout still
		// bounds it.
		response, err = s.svc.Client().Raw(context.WithoutCancel(r.Context()), payload)
	}
	if err != nil {
		writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/xml; charset=utf-8")
	w.Header().Set("Content-Length", strconv.Itoa(len(response)))
	_, _ = w.Write(response)
}

// rpcPayload is the methodCall a /RPC2 request carries, as XML or as JSON.
func (s *Server) rpcPayload(r *http.Request) ([]byte, error) {
	// Refused before a byte of the body is read.
	if !s.cfg.AllowRawRPC {
		return nil, errRawRPCDisabled
	}
	switch media, _ := mediaType(r); media {
	case "text/xml", "application/xml", "application/octet-stream":
		payload, err := readBody(r, rpcRawLimit)
		if err != nil || len(payload) > 0 {
			return payload, err
		}
	case "application/json":
		body, _, err := jsonBody(r, rpcJSONLimit)
		if err != nil {
			return nil, err
		}
		record, _ := body.(map[string]any)
		if _, named := record["method"].(string); named {
			method, err := validate.String(record["method"], "method", false)
			if err != nil {
				return nil, err
			}
			value, present := record["params"]
			params, err := rpcParams(value, present)
			if err != nil {
				return nil, err
			}
			payload, err := xmlrpc.EncodeCall(method, params)
			if err != nil {
				return nil, httperr.New(http.StatusBadRequest, err.Error())
			}
			return payload, nil
		}
	}
	return nil, httperr.New(http.StatusBadRequest, "expected an XML-RPC methodCall body")
}

// rpcParams checks raw RPC parameters: a list, of anything JSON can say, not
// nested past what any real command takes.
func rpcParams(value any, present bool) ([]any, error) {
	if !present {
		return []any{}, nil
	}
	list, ok := value.([]any)
	if !ok {
		return nil, httperr.New(http.StatusBadRequest, `"params" must be an array`)
	}
	var check func(item any, depth int) error
	check = func(item any, depth int) error {
		if depth > 100 {
			return httperr.New(http.StatusBadRequest, `"params" nesting is too deep`)
		}
		switch v := item.(type) {
		case []any:
			for _, child := range v {
				if err := check(child, depth+1); err != nil {
					return err
				}
			}
		case map[string]any:
			for _, child := range v {
				if err := check(child, depth+1); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := check(list, 0); err != nil {
		return nil, err
	}
	return list, nil
}

// jsonSafe renders base64 values, which JSON has no type for, as
// {"$base64": "..."}.
func jsonSafe(value any) any {
	switch v := value.(type) {
	case []byte:
		return map[string]string{"$base64": base64.StdEncoding.EncodeToString(v)}
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = jsonSafe(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = jsonSafe(item)
		}
		return out
	}
	return value
}
