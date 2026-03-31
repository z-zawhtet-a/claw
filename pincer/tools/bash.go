package tools

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

const maxOutputSize = 10 * 1024 * 1024 // 10MB — matches local bash tool

type BashParams struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"` // milliseconds
}

// readCapped reads up to limit bytes, then drains the rest to io.Discard
// so the child process doesn't block on a full pipe buffer.
func readCapped(r io.Reader, limit int64) []byte {
	data, _ := io.ReadAll(io.LimitReader(r, limit))
	io.Copy(io.Discard, r)
	return data
}

func Bash(p *BashParams) (*Result, error) {
	timeout := 120 * time.Second
	if p.Timeout > 0 {
		timeout = time.Duration(p.Timeout) * time.Millisecond
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "/bin/bash", "-c", p.Command)

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return &Result{Content: "Error: " + err.Error(), IsError: true}, nil
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return &Result{Content: "Error: " + err.Error(), IsError: true}, nil
	}

	if err := cmd.Start(); err != nil {
		return &Result{Content: "Error: " + err.Error(), IsError: true}, nil
	}

	// Read both pipes concurrently to avoid deadlock when one fills up
	var stdoutBytes, stderrBytes []byte
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		stdoutBytes = readCapped(stdoutPipe, maxOutputSize)
	}()
	go func() {
		defer wg.Done()
		stderrBytes = readCapped(stderrPipe, maxOutputSize)
	}()
	wg.Wait()

	runErr := cmd.Wait()

	output := string(stdoutBytes)
	if len(stderrBytes) > 0 {
		if output != "" {
			output += "\n"
		}
		output += string(stderrBytes)
	}

	truncated := len(stdoutBytes) >= int(maxOutputSize) || len(stderrBytes) >= int(maxOutputSize)
	if truncated {
		output += fmt.Sprintf("\n\n(output truncated at %d bytes)", maxOutputSize)
	}

	if output == "" {
		output = "(no output)"
	}

	if runErr != nil && len(stdoutBytes) == 0 && len(stderrBytes) == 0 {
		return &Result{Content: "Error: " + runErr.Error(), IsError: true}, nil
	}

	return &Result{Content: output, IsError: runErr != nil}, nil
}
