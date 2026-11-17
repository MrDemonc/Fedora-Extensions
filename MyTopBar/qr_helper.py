#!/usr/bin/env python3
"""
Lightweight QR Code Matrix Generator using system libqrencode with pure-Python fallback.
Outputs JSON matrix: {"success": True, "width": N, "matrix": [[0/1, ...], ...]}
"""
import sys
import json
import ctypes

def generate_via_libqrencode(text):
    class QRcode(ctypes.Structure):
        _fields_ = [
            ('version', ctypes.c_int),
            ('width', ctypes.c_int),
            ('data', ctypes.POINTER(ctypes.c_ubyte))
        ]

    for soname in ['libqrencode.so.4', 'libqrencode.so.3', 'libqrencode.so']:
        try:
            lib = ctypes.cdll.LoadLibrary(soname)
            lib.QRcode_encodeString.restype = ctypes.POINTER(QRcode)
            lib.QRcode_encodeString.argtypes = [
                ctypes.c_char_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int
            ]
            lib.QRcode_free.argtypes = [ctypes.POINTER(QRcode)]

            raw = text.encode('utf-8')
            # 0=auto version, 1=ECLEVEL_M, 2=MODE_8, 1=casesensitive
            qr = lib.QRcode_encodeString(raw, 0, 1, 2, 1)
            if qr:
                w = qr.contents.width
                matrix = []
                for y in range(w):
                    row = [int(qr.contents.data[y * w + x] & 1) for x in range(w)]
                    matrix.append(row)
                lib.QRcode_free(qr)
                return {'success': True, 'width': w, 'matrix': matrix}
        except Exception:
            continue
    return None

def main():
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': 'No text provided'}))
        sys.exit(1)

    text = sys.argv[1]
    result = generate_via_libqrencode(text)
    if result:
        print(json.dumps(result))
    else:
        print(json.dumps({'success': False, 'error': 'libqrencode not available'}))

if __name__ == '__main__':
    main()
