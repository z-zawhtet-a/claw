package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sync"

	"github.com/z-zawhtet-a/claw/pincer/rpc"
)

// Version is set via ldflags at build time: -X main.Version=<version>
var Version = "0.1.7"

var (
	writeMu sync.Mutex
	wg      sync.WaitGroup
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--version" {
		fmt.Println(Version)
		os.Exit(0)
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 0), 50*1024*1024) // 50MB buffer

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req rpc.Request
		if err := json.Unmarshal(line, &req); err != nil {
			resp := rpc.ErrorResponse(0, fmt.Sprintf("invalid JSON: %v", err))
			writeResponse(resp)
			continue
		}

		wg.Add(1)
		go func(r rpc.Request) {
			defer wg.Done()
			resp := rpc.RecoverToResponse(r.ID, func() *rpc.Response {
				return rpc.Dispatch(&r)
			})
			writeResponse(resp)
		}(req)
	}

	if err := scanner.Err(); err != nil {
		resp := rpc.ErrorResponse(0, fmt.Sprintf("stdin read error: %v", err))
		writeResponse(resp)
	}

	// Wait for in-flight requests to finish before exiting
	wg.Wait()
}

func writeResponse(resp *rpc.Response) {
	data, _ := json.Marshal(resp)
	writeMu.Lock()
	fmt.Println(string(data))
	writeMu.Unlock()
}
