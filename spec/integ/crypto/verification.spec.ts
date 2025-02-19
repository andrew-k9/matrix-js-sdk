/*
Copyright 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import fetchMock from "fetch-mock-jest";
import { MockResponse } from "fetch-mock";

import { createClient, MatrixClient } from "../../../src";
import { ShowSasCallbacks, VerifierEvent } from "../../../src/crypto-api/verification";
import { escapeRegExp } from "../../../src/utils";
import { VerificationBase } from "../../../src/crypto/verification/Base";
import { CRYPTO_BACKENDS, InitCrypto } from "../../test-utils/test-utils";
import { SyncResponder } from "../../test-utils/SyncResponder";
import {
    SIGNED_TEST_DEVICE_DATA,
    TEST_DEVICE_ID,
    TEST_DEVICE_PUBLIC_ED25519_KEY_BASE64,
    TEST_USER_ID,
} from "../../test-utils/test-data";
import { mockInitialApiRequests } from "../../test-utils/mockEndpoints";
import {
    Phase,
    VerificationRequest,
    VerificationRequestEvent,
} from "../../../src/crypto/verification/request/VerificationRequest";

// The verification flows use javascript timers to set timeouts. We tell jest to use mock timer implementations
// to ensure that we don't end up with dangling timeouts.
jest.useFakeTimers();

/**
 * Integration tests for verification functionality.
 *
 * These tests work by intercepting HTTP requests via fetch-mock rather than mocking out bits of the client, so as
 * to provide the most effective integration tests possible.
 */
describe.each(Object.entries(CRYPTO_BACKENDS))("verification (%s)", (backend: string, initCrypto: InitCrypto) => {
    // oldBackendOnly is an alternative to `it` or `test` which will skip the test if we are running against the
    // Rust backend. Once we have full support in the rust sdk, it will go away.
    const oldBackendOnly = backend === "rust-sdk" ? test.skip : test;

    /** the client under test */
    let aliceClient: MatrixClient;

    /** an object which intercepts `/sync` requests from {@link #aliceClient} */
    let syncResponder: SyncResponder;

    beforeEach(async () => {
        // anything that we don't have a specific matcher for silently returns a 404
        fetchMock.catch(404);
        fetchMock.config.warnOnFallback = false;

        const homeserverUrl = "https://alice-server.com";
        aliceClient = createClient({
            baseUrl: homeserverUrl,
            userId: TEST_USER_ID,
            accessToken: "akjgkrgjs",
            deviceId: "device_under_test",
        });

        await initCrypto(aliceClient);
    });

    afterEach(async () => {
        await aliceClient.stopClient();
        fetchMock.mockReset();
    });

    beforeEach(() => {
        syncResponder = new SyncResponder(aliceClient.getHomeserverUrl());
        mockInitialApiRequests(aliceClient.getHomeserverUrl());
        aliceClient.startClient();
    });

    oldBackendOnly("Outgoing verification: can verify another device via SAS", async () => {
        // expect requests to download our own keys
        fetchMock.post(new RegExp("/_matrix/client/(r0|v3)/keys/query"), {
            device_keys: {
                [TEST_USER_ID]: {
                    [TEST_DEVICE_ID]: SIGNED_TEST_DEVICE_DATA,
                },
            },
        });

        // have alice initiate a verification. She should send a m.key.verification.request
        let [requestBody, request] = await Promise.all([
            expectSendToDeviceMessage("m.key.verification.request"),
            aliceClient.requestVerification(TEST_USER_ID, [TEST_DEVICE_ID]),
        ]);
        const transactionId = request.channel.transactionId;
        expect(transactionId).toBeDefined();
        expect(request.phase).toEqual(Phase.Requested);

        let toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
        expect(toDeviceMessage.methods).toContain("m.sas.v1");
        expect(toDeviceMessage.from_device).toEqual(aliceClient.deviceId);
        expect(toDeviceMessage.transaction_id).toEqual(transactionId);

        // The dummy device replies with an m.key.verification.ready...
        returnToDeviceMessageFromSync({
            type: "m.key.verification.ready",
            content: {
                from_device: TEST_DEVICE_ID,
                methods: ["m.sas.v1"],
                transaction_id: transactionId,
            },
        });
        await waitForVerificationRequestChanged(request);
        expect(request.phase).toEqual(Phase.Ready);

        // ... and picks a method with m.key.verification.start
        returnToDeviceMessageFromSync({
            type: "m.key.verification.start",
            content: {
                from_device: TEST_DEVICE_ID,
                method: "m.sas.v1",
                transaction_id: transactionId,
                hashes: ["sha256"],
                key_agreement_protocols: ["curve25519"],
                message_authentication_codes: ["hkdf-hmac-sha256.v2"],
                short_authentication_string: ["emoji"],
            },
        });
        await waitForVerificationRequestChanged(request);
        expect(request.phase).toEqual(Phase.Started);
        expect(request.chosenMethod).toEqual("m.sas.v1");

        // there should now be a verifier
        const verifier: VerificationBase = request.verifier!;
        expect(verifier).toBeDefined();

        // start off the verification process: alice will send an `accept`
        const verificationPromise = verifier.verify();
        // advance the clock, because the devicelist likes to sleep for 5ms during key downloads
        jest.advanceTimersByTime(10);

        requestBody = await expectSendToDeviceMessage("m.key.verification.accept");
        toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
        expect(toDeviceMessage.key_agreement_protocol).toEqual("curve25519");
        expect(toDeviceMessage.short_authentication_string).toEqual(["emoji"]);
        expect(toDeviceMessage.transaction_id).toEqual(transactionId);

        // The dummy device makes up a curve25519 keypair and sends the public bit back in an `m.key.verification.key'
        // We use the Curve25519, HMAC and HKDF implementations in libolm, for now
        const olmSAS = new global.Olm.SAS();
        returnToDeviceMessageFromSync({
            type: "m.key.verification.key",
            content: {
                transaction_id: transactionId,
                key: olmSAS.get_pubkey(),
            },
        });

        // alice responds with a 'key' ...
        requestBody = await expectSendToDeviceMessage("m.key.verification.key");
        toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
        expect(toDeviceMessage.transaction_id).toEqual(transactionId);
        const aliceDevicePubKeyBase64 = toDeviceMessage.key;
        olmSAS.set_their_key(aliceDevicePubKeyBase64);

        // ... and the client is notified to show the emoji
        const showSas = await new Promise<ShowSasCallbacks>((resolve) => {
            verifier.once(VerifierEvent.ShowSas, resolve);
        });

        // user confirms that the emoji match, and alice sends a 'mac'
        [requestBody] = await Promise.all([expectSendToDeviceMessage("m.key.verification.mac"), showSas.confirm()]);
        toDeviceMessage = requestBody.messages[TEST_USER_ID][TEST_DEVICE_ID];
        expect(toDeviceMessage.transaction_id).toEqual(transactionId);

        // the dummy device also confirms that the emoji match, and sends a mac
        const macInfoBase = `MATRIX_KEY_VERIFICATION_MAC${TEST_USER_ID}${TEST_DEVICE_ID}${TEST_USER_ID}${aliceClient.deviceId}${transactionId}`;
        returnToDeviceMessageFromSync({
            type: "m.key.verification.mac",
            content: {
                keys: calculateMAC(olmSAS, `ed25519:${TEST_DEVICE_ID}`, `${macInfoBase}KEY_IDS`),
                transaction_id: transactionId,
                mac: {
                    [`ed25519:${TEST_DEVICE_ID}`]: calculateMAC(
                        olmSAS,
                        TEST_DEVICE_PUBLIC_ED25519_KEY_BASE64,
                        `${macInfoBase}ed25519:${TEST_DEVICE_ID}`,
                    ),
                },
            },
        });

        // that should satisfy Alice, who should reply with a 'done'
        await expectSendToDeviceMessage("m.key.verification.done");

        // ... and the whole thing should be done!
        await verificationPromise;
        expect(request.phase).toEqual(Phase.Done);

        // we're done with the temporary keypair
        olmSAS.free();
    });

    function returnToDeviceMessageFromSync(ev: { type: string; content: object; sender?: string }): void {
        ev.sender ??= TEST_USER_ID;
        syncResponder.sendOrQueueSyncResponse({ to_device: { events: [ev] } });
    }
});

/**
 * Wait for the client under test to send a to-device message of the given type.
 *
 * @param msgtype - type of to-device message we expect
 * @returns A Promise which resolves with the body of the HTTP request
 */
function expectSendToDeviceMessage(msgtype: string): Promise<{ messages: any }> {
    return new Promise((resolve) => {
        fetchMock.putOnce(
            new RegExp(`/_matrix/client/(r0|v3)/sendToDevice/${escapeRegExp(msgtype)}`),
            (url: string, opts: RequestInit): MockResponse => {
                resolve(JSON.parse(opts.body as string));
                return {};
            },
        );
    });
}

/** wait for the verification request to emit a 'Change' event */
function waitForVerificationRequestChanged(request: VerificationRequest): Promise<void> {
    return new Promise<void>((resolve) => {
        request.once(VerificationRequestEvent.Change, resolve);
    });
}

/** Perform a MAC calculation on the given data
 *
 * Does an HKDR and HMAC as defined by the matrix spec (https://spec.matrix.org/v1.7/client-server-api/#mac-calculation,
 * as amended by https://github.com/matrix-org/matrix-spec/issues/1553).
 *
 * @param olmSAS
 * @param input
 * @param info
 */
function calculateMAC(olmSAS: Olm.SAS, input: string, info: string): string {
    const mac = olmSAS.calculate_mac_fixed_base64(input, info);
    //console.info(`Test MAC: input:'${input}, info: '${info}' -> '${mac}`);
    return mac;
}
