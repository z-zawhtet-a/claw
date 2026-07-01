package rpc

import "testing"

func TestRecoverToResponseCatchesPanic(t *testing.T) {
	resp := RecoverToResponse(7, func() *Response {
		panic("boom")
	})
	if resp == nil {
		t.Fatal("expected a response, got nil")
	}
	if !resp.IsError {
		t.Errorf("expected IsError=true, got false")
	}
	if resp.ID != 7 {
		t.Errorf("expected ID=7, got %d", resp.ID)
	}
}

func TestRecoverToResponsePassesThrough(t *testing.T) {
	want := &Response{ID: 3, Result: "ok"}
	got := RecoverToResponse(3, func() *Response { return want })
	if got != want {
		t.Errorf("expected pass-through of the returned response")
	}
}
