package tools

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadOffsetLimitOverflowDoesNotPanic(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "f.txt")
	if err := os.WriteFile(f, []byte("a\nb\nc\n"), 0644); err != nil {
		t.Fatal(err)
	}
	offset := 1
	limit := math.MaxInt // offset+limit overflows int64 → negative
	res, err := Read(&ReadParams{Path: f, Offset: &offset, Limit: &limit})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected tool error: %s", res.Content)
	}
}

func TestReadRejectsNonRegularFile(t *testing.T) {
	dir := t.TempDir() // a directory is non-regular
	res, err := Read(&ReadParams{Path: dir})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Fatalf("expected error for non-regular file, got: %s", res.Content)
	}
	if !strings.Contains(res.Content, "not a regular file") {
		t.Fatalf("expected the IsRegular guard message, got: %s", res.Content)
	}
}
