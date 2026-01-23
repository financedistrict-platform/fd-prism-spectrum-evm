// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC3009
 * @author Prism Spectrum Team
 * @notice Minimal mock token implementing subset of EIP-3009 (transferWithAuthorization) for testing SpectrumSettlement
 * @dev SECURITY: Simplified signature acceptance (does not actually verify EIP-712 signed data). DO NOT USE IN PROD.
 *      - Accepts any call where:
 *          * !usedNonces[from][nonce]
 *          * current block timestamp within [validAfter, validBefore]
 *      - Marks nonce used and performs ERC20 transfer.
 */
contract MockERC3009 is ERC20 {
    /// @notice Tracks used nonces per address
    mapping(address => mapping(bytes32 => bool)) public usedNonces;

    /**
     * @notice Emitted when an authorization is consumed
     * @param authorizer Address that authorized the transfer
     * @param nonce Unique nonce used for the authorization
     */
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationNotYetValid(uint256 validAfter, uint256 nowTs);
    error AuthorizationExpired(uint256 validBefore, uint256 nowTs);
    error AuthorizationUsedAlready(address authorizer, bytes32 nonce);

    /**
     * @notice Initialize mock ERC3009 token
     * @param name_ Token name
     * @param symbol_ Token symbol
     */
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    /**
     * @notice Mint tokens to an address (test helper)
     * @param to Recipient address
     * @param amount Amount to mint
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /**
     * @notice Mock implementation: ignores signature (v,r,s) and msg.sender checks; validates timing & nonce only
     * @param from Token holder address
     * @param to Recipient address
     * @param value Amount to transfer
     * @param validAfter Timestamp after which authorization is valid
     * @param validBefore Timestamp before which authorization is valid
     * @param nonce Unique authorization nonce
     * @param v Signature component (ignored in mock)
     * @param r Signature component (ignored in mock)
     * @param s Signature component (ignored in mock)
     */
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // Silence unused parameters (signature pieces) for mock
        v;
        r;
        s;
        if (block.timestamp < validAfter) revert AuthorizationNotYetValid(validAfter, block.timestamp);
        if (block.timestamp > validBefore) revert AuthorizationExpired(validBefore, block.timestamp);
        if (usedNonces[from][nonce]) revert AuthorizationUsedAlready(from, nonce);
        usedNonces[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }

    /**
     * @notice Transfer tokens with authorization where caller must be the recipient
     * @dev Function requires msg.sender to equal the recipient address
     * @param from Token holder address
     * @param to Recipient address (must equal msg.sender)
     * @param value Amount to transfer
     * @param validAfter Timestamp after which authorization is valid
     * @param validBefore Timestamp before which authorization is valid
     * @param nonce Unique authorization nonce
     * @param v Signature component (ignored in mock)
     * @param r Signature component (ignored in mock)
     * @param s Signature component (ignored in mock)
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // Enforce caller is recipient
        require(to == msg.sender, "FiatToken: caller must be the recipient");
        
        // Silence unused parameters (signature pieces) for mock
        v;
        r;
        s;
        if (block.timestamp < validAfter) revert AuthorizationNotYetValid(validAfter, block.timestamp);
        if (block.timestamp > validBefore) revert AuthorizationExpired(validBefore, block.timestamp);
        if (usedNonces[from][nonce]) revert AuthorizationUsedAlready(from, nonce);
        usedNonces[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        _transfer(from, to, value);
    }
}
