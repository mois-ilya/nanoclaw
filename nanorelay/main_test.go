package main

import (
	"io"
	"net"
	"testing"
)

func TestParseMap(t *testing.T) {
	r, err := parseMap("8080=nanogate:8080, 3128=nanogate:3128")
	if err != nil || len(r) != 2 || r[1].listen != ":3128" || r[1].target != "nanogate:3128" {
		t.Fatalf("got %v %v", r, err)
	}
	for _, bad := range []string{"", "8080", "8080=", "=x:1", "8080=nohostport"} {
		if _, err := parseMap(bad); err == nil {
			t.Fatalf("expected error for %q", bad)
		}
	}
}

func TestPipe(t *testing.T) {
	up, _ := net.Listen("tcp", "127.0.0.1:0")
	go func() {
		c, _ := up.Accept()
		io.Copy(c, c)
		c.Close()
	}()
	a, b := net.Pipe()
	go pipe(b, up.Addr().String())
	a.Write([]byte("ping"))
	buf := make([]byte, 4)
	io.ReadFull(a, buf)
	if string(buf) != "ping" {
		t.Fatalf("echo got %q", buf)
	}
	a.Close()
}
