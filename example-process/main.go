package main

import (
	"fmt"
	"time"
)

func main() {
	fmt.Println("Starting our fake process...")
	printTenTimes()
}

func printTenTimes() {
	for i := 0; i < 5; i++ {
		fmt.Println("Looping...")
		doNothingButLoop()
		time.Sleep(5 * time.Second)
	}
}

// This is just busy work to produce some profiles.
func doNothingButLoop() {
	for j := 0; j < 10000000000; j++ {
	}
	fmt.Println("Done")
}
