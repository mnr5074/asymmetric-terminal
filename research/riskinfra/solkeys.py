"""Minimal Solana key helpers (base58, PDA derivation with ed25519 on-curve check) - pure python, no deps."""
import hashlib
B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58d(s):
    n = 0
    for c in s: n = n * 58 + B58.index(c)
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big') if n else b''
    return b'\0' * (len(s) - len(s.lstrip('1'))) + b
def b58e(b):
    n = int.from_bytes(b, 'big'); s = ''
    while n: n, r = divmod(n, 58); s = B58[r] + s
    return '1' * (len(b) - len(b.lstrip(b'\0'))) + s
P = 2 ** 255 - 19; D = (-121665 * pow(121666, P - 2, P)) % P; I = pow(2, (P - 1) // 4, P)
def on_curve(b):
    y = int.from_bytes(b, 'little') & ((1 << 255) - 1)
    if y >= P: return False
    x2 = (y * y - 1) * pow(D * y * y + 1, P - 2, P) % P
    if x2 == 0: return True
    x = pow(x2, (P + 3) // 8, P)
    if (x * x - x2) % P != 0: x = x * I % P
    return (x * x - x2) % P == 0
def pda(seeds, program):
    pid = b58d(program)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b''.join(seeds) + bytes([bump]) + pid + b'ProgramDerivedAddress').digest()
        if not on_curve(h): return b58e(h)
    raise ValueError('no pda')
PYTH_PUSH = 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT'
def pyth_feed_account(feed_hex, shard=0):
    return pda([shard.to_bytes(2, 'little'), bytes.fromhex(feed_hex.replace('0x', ''))], PYTH_PUSH)
if __name__ == '__main__':
    print(pyth_feed_account('e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43'))
