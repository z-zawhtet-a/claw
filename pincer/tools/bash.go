package tools

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"time"
)

const maxOutputSize = 10 * 1024 * 1024 // 10MB — matches local bash tool

type BashParams struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout,omitempty"` // milliseconds
}

func Bash(p *BashParams) (*Result, error) {
	timeout := 120 * time.Second
	if p.Timeout > 0 {
		timeout = time.Duration(p.Timeout) * time.Millisecond
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "/bin/bash", "-c", p.Command)

	// Cap output to maxOutputSize using LimitedReader on pipes
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

	stdoutBytes, _ := io.ReadAll(io.LimitReader(stdoutPipe, maxOutputSize))
	stderrBytes, _ := io.ReadAll(io.LimitReader(stderrPipe, maxOutputSize))

	runErr := cmd.Wait()

	output := string(stdoutBytes)
	if len(stderrBytes) > 0 {
		if output != "" {
			output += "\n"
		}
		output += string(stderrBytes)
	}

	truncated := len(stdoutBytes) >= maxOutputSize || len(stderrBytes) >= maxOutputSize
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
