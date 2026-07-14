# Reverse Engineering

Notes on how the iLnkP2P protocol was reverse-engineered.

## Tools used

- [Ghidra](https://ghidra-sre.org/) -- static analysis of `libvdp.so` from the APK
- [Frida](https://frida.re/docs/javascript-api/) -- dynamic analysis and function hooking
- Wireshark -- network traffic analysis with custom dissector

## Sources

The interesting implementation is in `libvdp.so`, part of the YsxLite APK bundle.

### Extracting the APK

```bash
adb shell pm list packages | grep ysx
adb shell pm path com.ysxlite.cam
adb shell pm path com.ysxlite.cam | while read -r line ; do
  adb pull $(echo $line | cut -d: -f2-)
done
```

### Installing on a test device

```bash
adb install-multiple *apk
```

### Frida setup

[Android docs](https://frida.re/docs/android/)

Start frida server:
```bash
adb shell 'su -c nohup /data/local/tmp/frida-server-16.1.11-android-arm64 &'
```

### Files

| File | Description |
|------|-------------|
| `func_replacements.js` | Frida hooks -- `Interceptor.replace` for `NetCmd`, `CmdSndPush`, `AvCmd`, `SystemCmd`. Contains JS translations of the original C functions: `XqBytesEnc`/`XqBytesDec`, packet builders |
| `frida-hooks.js` | Playground for Frida hooks (mostly cleaned up) |
| `dissector.lua` | Wireshark dissector for the iLnkP2P protocol on UDP port 32108 |
| `types/all.h` | Ghidra-reversed header definitions (barely used by this implementation) |

## Ghidra headers

Reversed struct/enum definitions are in `types/all.h`. They document the C structures used by `libvdp.so` but are not directly used by the TypeScript implementation.

## Wireshark dissector

Install:
```bash
make install-wireshark-dissector
```

The dissector (`dissector.lua`) registers on UDP port 32108 with heuristic detection. It decodes all command types, Drw control/data packets, PunchPkt serial numbers, and performs in-place deobfuscation of encrypted payloads.

## Serial debugging

The A9 cameras have TX/RX test points. UART at 921600 8N1 gives read-only access to debug logs.

## Discrepancies between cameras

- A9 reports 100% WiFi strength; X5 reports actual values
- Video resolution values 3 and 4 both map to 640x480 on X5
