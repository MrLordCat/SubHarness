import * as assert from "node:assert";
import { describeClaudeAuth, parseClaudeAuthStatus, readClaudeAuthStatus, signOutClaudeCli, type ClaudeAuthCommandResult, type ClaudeAuthRunner } from "../claude/auth";

interface FakeRunner {
	run: ClaudeAuthRunner;
	calls: Array<{ executable: string; args: string[] }>;
}

function fakeRunner(result: Partial<ClaudeAuthCommandResult>): FakeRunner {
	const calls: Array<{ executable: string; args: string[] }> = [];
	return {
		calls,
		run: async (executable, args) => {
			calls.push({ executable, args: [...args] });
			return { code: 0, stdout: "", stderr: "", ...result };
		},
	};
}

suite("Claude auth", () => {
	test("reads a subscription status and leaves out the account details", () => {
		const output = JSON.stringify({
			loggedIn: true,
			authMethod: "claude.ai",
			apiProvider: "firstParty",
			email: "user@example.com",
			orgId: "org-1",
			orgName: "Example",
			subscriptionType: "max",
		});
		assert.deepStrictEqual(parseClaudeAuthStatus(output), { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", apiProvider: "firstParty" });
	});

	test("finds the JSON after a warning line", () => {
		const output = "Warning: the config file is old\r\n{\"loggedIn\":false}\r\n";
		assert.deepStrictEqual(parseClaudeAuthStatus(output), { loggedIn: false });
	});

	test("trims fields and drops blank ones", () => {
		const output = JSON.stringify({ loggedIn: true, authMethod: " claude.ai ", subscriptionType: "  ", apiProvider: 7 });
		assert.deepStrictEqual(parseClaudeAuthStatus(output), { loggedIn: true, authMethod: "claude.ai" });
	});

	test("rejects output without a status object", () => {
		for (const output of ["", "not signed in", "{\"loggedIn\":\"yes\"}", "{\"authMethod\":\"claude.ai\"}", "{\"loggedIn\":true", "} {", "[true]", "null"]) {
			assert.strictEqual(parseClaudeAuthStatus(output), undefined, JSON.stringify(output));
		}
	});

	test("describes each kind of status", () => {
		assert.strictEqual(describeClaudeAuth(undefined), "status unknown");
		assert.strictEqual(describeClaudeAuth({ loggedIn: false, authMethod: "claude.ai" }), "not signed in");
		assert.strictEqual(describeClaudeAuth({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }), "Claude subscription (Pro)");
		assert.strictEqual(describeClaudeAuth({ loggedIn: true, authMethod: "claude.ai" }), "Claude subscription");
		assert.strictEqual(describeClaudeAuth({ loggedIn: true, authMethod: "console" }), "console (not a Claude subscription)");
		assert.strictEqual(describeClaudeAuth({ loggedIn: true }), "unknown method (not a Claude subscription)");
	});

	test("readClaudeAuthStatus runs auth status and parses its output", async () => {
		const runner = fakeRunner({ stdout: "{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"subscriptionType\":\"pro\"}\n" });
		assert.deepStrictEqual(await readClaudeAuthStatus("C:\\claude.exe", runner.run), { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });
		assert.deepStrictEqual(runner.calls, [{ executable: "C:\\claude.exe", args: ["status"] }]);
	});

	test("readClaudeAuthStatus gives undefined for output it cannot read", async () => {
		const runner = fakeRunner({ code: 1, stdout: "Error: unknown command", stderr: "" });
		assert.strictEqual(await readClaudeAuthStatus("claude", runner.run), undefined);
	});

	test("signOutClaudeCli runs auth logout", async () => {
		const runner = fakeRunner({ stdout: "Successfully logged out.\n" });
		await signOutClaudeCli("claude", runner.run);
		assert.deepStrictEqual(runner.calls, [{ executable: "claude", args: ["logout"] }]);
	});

	test("signOutClaudeCli reports the last line of a failure", async () => {
		await assert.rejects(
			signOutClaudeCli("claude", fakeRunner({ code: 1, stdout: "ignored", stderr: "Logging out\r\nError: the keychain is locked\r\n" }).run),
			{ message: "claude auth logout failed: Error: the keychain is locked" },
		);
		await assert.rejects(
			signOutClaudeCli("claude", fakeRunner({ code: 2, stdout: "Not logged in\n" }).run),
			{ message: "claude auth logout failed: Not logged in" },
		);
		await assert.rejects(signOutClaudeCli("claude", fakeRunner({ code: 3 }).run), { message: "claude auth logout exited with code 3" });
	});
});
