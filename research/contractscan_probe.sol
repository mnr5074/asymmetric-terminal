// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
interface IERC20 { function balanceOf(address) external view returns (uint256); }
contract Probe {
    function bal(address t, address a) internal view returns (uint256 b, bool ok) {
        (bool s, bytes memory r) = t.staticcall(abi.encodeWithSelector(0x70a08231, a));
        if (s && r.length >= 32) { b = abi.decode(r, (uint256)); ok = true; }
    }
    // Transfer `amt` of token `t` from this contract's address (code-overridden holder) to `to`.
    // Returns success, revert data, amount debited from sender, amount credited to recipient.
    function probe(address t, address to, uint256 amt) external returns (bool ok, uint256 sent, uint256 recv, bytes memory ret) {
        (uint256 a0,) = bal(t, address(this)); (uint256 b0,) = bal(t, to);
        (ok, ret) = t.call(abi.encodeWithSelector(0xa9059cbb, to, amt));
        if (ok && ret.length >= 32) { ok = abi.decode(ret, (bool)); }
        (uint256 a1,) = bal(t, address(this)); (uint256 b1,) = bal(t, to);
        sent = a0 >= a1 ? a0 - a1 : 0; recv = b1 >= b0 ? b1 - b0 : 0;
    }
}
