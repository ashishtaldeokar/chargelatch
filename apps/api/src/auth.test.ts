import { expect, test } from "bun:test";
import { errors } from "jose";
import { describeTokenError } from "./auth.ts";

test("token rejections name the claim that failed", () => {
  expect(describeTokenError(new errors.JWTClaimValidationFailed("unexpected aud", {}, "aud", "check_failed"))).toContain("audience mapper");
  expect(describeTokenError(new errors.JWTClaimValidationFailed("unexpected iss", {}, "iss", "check_failed"))).toContain("KEYCLOAK_ISSUER");
  expect(describeTokenError(new errors.JWTExpired("expired", {}, "exp", "check_failed"))).toBe("Token expired");
  expect(describeTokenError(new errors.JWSSignatureVerificationFailed())).toContain("signature");
  expect(describeTokenError(new Error("garbage"))).toBe("Invalid token");
});
