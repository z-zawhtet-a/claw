package tools

import (
	"fmt"
	"os"
	"strings"
)

type ReadParams struct {
	Path   string `json:"path"`
	Offset *int   `json:"offset,omitempty"`
	Limit  *int   `json:"limit,omitempty"`
}

const maxFileSize = 100 * 1024 * 1024 // 100MB

func Read(p *ReadParams) (*Result, error) {
	info, err := os.Stat(p.Path)
	if err != nil {
		return &Result{Content: "Error reading file: " + err.Error(), IsError: true}, nil
	}
	if !info.Mode().IsRegular() {
		return &Result{Content: "Error: " + p.Path + " is not a regular file", IsError: true}, nil
	}
	if info.Size() > maxFileSize {
		return &Result{
			Content: fmt.Sprintf("Error: file is %dMB, exceeds %dMB limit. Use bash with head/tail/sed to read portions.", info.Size()/1024/1024, maxFileSize/1024/1024),
			IsError: true,
		}, nil
	}

	data, err := os.ReadFile(p.Path)
	if err != nil {
		return &Result{Content: "Error reading file: " + err.Error(), IsError: true}, nil
	}

	lines := strings.Split(string(data), "\n")

	offset := 0
	if p.Offset != nil {
		offset = *p.Offset
	}
	if offset < 0 {
		offset = 0
	}
	if offset > len(lines) {
		offset = len(lines)
	}

	limit := len(lines) - offset
	if p.Limit != nil {
		limit = *p.Limit
	}
	if limit < 0 {
		limit = 0
	}

	end := offset + limit
	if end < offset || end > len(lines) { // end < offset catches integer overflow
		end = len(lines)
	}

	sliced := lines[offset:end]

	var numbered []string
	for i, line := range sliced {
		numbered = append(numbered, fmt.Sprintf("%d\t%s", offset+i+1, line))
	}

	return &Result{Content: strings.Join(numbered, "\n")}, nil
}
