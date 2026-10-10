// nanorelay is the per-session gateway container of the session-container
// topology: it sits on the session's internal network (alias = gateway
// endpoint) and on the internal nanogate service network, and forwards a
// fixed set of TCP ports to nanogate. It holds no secrets, parses nothing,
// and is not a router — authentication happens in nanogate.
//
// Config: NANORELAY_MAP="8080=nanogate:8080,3128=nanogate:3128"
package main

import (
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

type route struct{ listen, target string }

func parseMap(s string) ([]route, error) {
	var out []route
	for _, part := range strings.Split(s, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 || kv[0] == "" || kv[1] == "" {
			return nil, fmt.Errorf("bad mapping %q", part)
		}
		if _, _, err := net.SplitHostPort(kv[1]); err != nil {
			return nil, fmt.Errorf("bad target %q: %v", kv[1], err)
		}
		out = append(out, route{listen: ":" + kv[0], target: kv[1]})
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("NANORELAY_MAP is empty")
	}
	return out, nil
}

const maxConns = 256

func serve(r route, sem chan struct{}) error {
	ln, err := net.Listen("tcp", r.listen)
	if err != nil {
		return err
	}
	log.Printf("relay %s -> %s", r.listen, r.target)
	for {
		c, err := ln.Accept()
		if err != nil {
			log.Printf("accept %s: %v", r.listen, err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		select {
		case sem <- struct{}{}:
		default:
			c.Close()
			continue
		}
		go func() {
			defer func() { <-sem }()
			pipe(c, r.target)
		}()
	}
}

func pipe(c net.Conn, target string) {
	defer c.Close()
	u, err := net.DialTimeout("tcp", target, 10*time.Second)
	if err != nil {
		log.Printf("dial %s: %v", target, err)
		return
	}
	defer u.Close()
	var wg sync.WaitGroup
	wg.Add(2)
	cp := func(dst, src net.Conn) {
		defer wg.Done()
		io.Copy(dst, src)
		if tc, ok := dst.(*net.TCPConn); ok {
			tc.CloseWrite()
		}
	}
	go cp(u, c)
	go cp(c, u)
	wg.Wait()
}

func main() {
	routes, err := parseMap(os.Getenv("NANORELAY_MAP"))
	if err != nil {
		log.Fatal(err)
	}
	sem := make(chan struct{}, maxConns)
	errc := make(chan error, len(routes))
	for _, r := range routes {
		go func(r route) { errc <- serve(r, sem) }(r)
	}
	log.Fatal(<-errc)
}
