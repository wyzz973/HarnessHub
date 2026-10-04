// SPDX-License-Identifier: MIT
import test from "node:test";
import assert from "node:assert/strict";
import {
  awsEscape,
  RateLimited,
  RemoteChanged,
  RemoteError,
  S3Remote,
  sha256Hex,
  signV4,
  WebDavRemote,
  type Fetch,
} from "../src/sync-remote.js";

const EMPTY = sha256Hex("");

/**
 * AWS's published examples: the SigV4 test suite (service "service") and the
 * S3 documentation's, which sign a range, a key with `$` in it, a Date
 * header, and queries with a name alone and with values.
 */
void test("SigV4 signatures match AWS's published examples", () => {
  const suite = {
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "service",
  };
  const s3 = {
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
  };
  const suiteAt = new Date(Date.UTC(2015, 7, 30, 12, 36, 0));
  const s3At = new Date(Date.UTC(2013, 4, 24, 0, 0, 0));
  const cases: Array<{
    name: string;
    credentials: typeof suite;
    at: Date;
    method: string;
    url: string;
    headers: Record<string, string>;
    payload: string;
    want: string;
  }> = [
    {
      name: "get-vanilla",
      credentials: suite,
      at: suiteAt,
      method: "GET",
      url: "https://example.amazonaws.com/",
      headers: {},
      payload: EMPTY,
      want: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    },
    {
      name: "get-vanilla-query-order-key-case",
      credentials: suite,
      at: suiteAt,
      method: "GET",
      url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      headers: {},
      payload: EMPTY,
      want: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    },
    {
      name: "post-vanilla",
      credentials: suite,
      at: suiteAt,
      method: "POST",
      url: "https://example.amazonaws.com/",
      headers: {},
      payload: EMPTY,
      want: "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b",
    },
    {
      name: "S3 GET object",
      credentials: s3,
      at: s3At,
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/test.txt",
      headers: { Range: "bytes=0-9", "x-amz-content-sha256": EMPTY },
      payload: EMPTY,
      want: "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    },
    {
      name: "S3 PUT object",
      credentials: s3,
      at: s3At,
      method: "PUT",
      url: `https://examplebucket.s3.amazonaws.com/${awsEscape("test$file.text", true)}`,
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
        "x-amz-content-sha256": sha256Hex("Welcome to Amazon S3."),
      },
      payload: sha256Hex("Welcome to Amazon S3."),
      want: "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    },
    {
      name: "S3 GET lifecycle",
      credentials: s3,
      at: s3At,
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/?lifecycle",
      headers: { "x-amz-content-sha256": EMPTY },
      payload: EMPTY,
      want: "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    },
    {
      name: "S3 list objects",
      credentials: s3,
      at: s3At,
      method: "GET",
      url: "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
      headers: { "x-amz-content-sha256": EMPTY },
      payload: EMPTY,
      want: "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    },
  ];
  for (const item of cases) {
    const signed = signV4(
      item.credentials,
      item.method,
      new URL(item.url),
      item.headers,
      item.payload,
      item.at,
    );
    assert.equal(signed.authorization, item.want, item.name);
    assert.match(signed["x-amz-date"]!, /^\d{8}T\d{6}Z$/);
  }
  assert.equal(awsEscape("a b/c~d+e$é", true), "a%20b/c~d%2Be%24%C3%A9");
  assert.equal(awsEscape("a/b", false), "a%2Fb");
});

/** A fetch that answers from a list and records each request. */
function scripted(
  answers: Array<(url: URL, init: RequestInit) => Response>,
): Fetch & {
  calls: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
  }>;
} {
  const calls: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
  }> = [];
  const fetch = async (url: URL, init: RequestInit) => {
    calls.push({
      method: init.method ?? "GET",
      url: url.href,
      headers: { ...(init.headers as Record<string, string>) },
    });
    const answer = answers.shift();
    assert.ok(answer, `unexpected ${init.method} ${url.href}`);
    return answer(url, init);
  };
  return Object.assign(fetch, { calls });
}

const signal = new AbortController().signal;

void test("a WebDAV address at a server's root addresses its folder there, makes it once and writes over the version read", async () => {
  const fetch = scripted([
    () => new Response(null, { status: 404 }),
    () => new Response(null, { status: 409 }),
    () => new Response(null, { status: 201 }),
    () => new Response(null, { status: 201, headers: { etag: '"v1"' } }),
    () =>
      new Response(null, { status: 200, headers: { "content-length": "4" } }),
    () => new Response(null, { status: 412 }),
  ]);
  const remote = new WebDavRemote({
    url: "https://dav.example.invalid",
    user: "u",
    password: "p",
    fetch,
  });
  assert.deepEqual(await remote.get({}, signal), { status: "absent" });
  assert.deepEqual(await remote.put(Buffer.from("data"), undefined, signal), {
    etag: '"v1"',
  });
  await assert.rejects(
    remote.put(Buffer.from("data"), '"v0"', signal),
    (error: unknown) => error instanceof RemoteChanged,
  );
  assert.deepEqual(
    fetch.calls.map((call) => [call.method, call.url]),
    [
      [
        "GET",
        "https://dav.example.invalid/harnesshub/harnesshub.harnesshub-backup",
      ],
      [
        "PUT",
        "https://dav.example.invalid/harnesshub/harnesshub.harnesshub-backup",
      ],
      ["MKCOL", "https://dav.example.invalid/harnesshub/"],
      [
        "PUT",
        "https://dav.example.invalid/harnesshub/harnesshub.harnesshub-backup",
      ],
      [
        "HEAD",
        "https://dav.example.invalid/harnesshub/harnesshub.harnesshub-backup",
      ],
      [
        "PUT",
        "https://dav.example.invalid/harnesshub/harnesshub.harnesshub-backup",
      ],
    ],
  );
  assert.equal(fetch.calls[1]!.headers["if-none-match"], "*");
  assert.equal(fetch.calls[5]!.headers["if-match"], '"v0"');
  assert.equal(
    fetch.calls[0]!.headers.authorization,
    `Basic ${Buffer.from("u:p").toString("base64")}`,
  );
});

void test("a write a relay cut short is written again over the version it left", async () => {
  const fetch = scripted([
    () => new Response(null, { status: 204, headers: { etag: '"short"' } }),
    () =>
      new Response(null, { status: 200, headers: { "content-length": "2" } }),
    () => new Response(null, { status: 204, headers: { etag: '"whole"' } }),
    () =>
      new Response(null, { status: 200, headers: { "content-length": "4" } }),
  ]);
  const remote = new WebDavRemote({
    url: "https://dav.example.invalid/dav/",
    fetch,
  });
  assert.deepEqual(await remote.put(Buffer.from("data"), '"v1"', signal), {
    etag: '"whole"',
  });
  assert.equal(fetch.calls[2]!.headers["if-match"], '"short"');
});

void test("a server limiting requests says how long to wait; a refused login is not retried", async () => {
  const limited = new WebDavRemote({
    url: "https://dav.example.invalid",
    fetch: scripted([
      () =>
        new Response(null, { status: 429, headers: { "retry-after": "120" } }),
    ]),
  });
  await assert.rejects(limited.get({}, signal), (error: unknown) => {
    assert.ok(error instanceof RateLimited);
    assert.equal(error.afterMs, 120_000);
    return true;
  });
  const refused = new WebDavRemote({
    url: "https://dav.example.invalid",
    fetch: scripted([() => new Response(null, { status: 401 })]),
  });
  await assert.rejects(refused.get({}, signal), RemoteError);
});

void test("S3 addresses: virtual-hosted on AWS, path-style for addresses and dotted buckets, R2's region", () => {
  const urls = (options: ConstructorParameters<typeof S3Remote>[0]) => {
    const fetch = scripted([() => new Response(null, { status: 404 })]);
    return { remote: new S3Remote({ ...options, fetch }), fetch };
  };
  const at = async (options: ConstructorParameters<typeof S3Remote>[0]) => {
    const { remote, fetch } = urls(options);
    await remote.get({}, signal);
    return fetch.calls[0]!;
  };
  const base = { accessKeyId: "AKID", secretAccessKey: "secret" };
  return Promise.all([
    at({ ...base, url: "s3://bucket/team/" }).then((call) =>
      assert.equal(
        call.url,
        "https://bucket.s3.us-east-1.amazonaws.com/team/harnesshub/harnesshub.harnesshub-backup",
      ),
    ),
    at({ ...base, url: "s3://my.bucket", region: "eu-west-1" }).then((call) =>
      assert.equal(
        call.url,
        "https://s3.eu-west-1.amazonaws.com/my.bucket/harnesshub/harnesshub.harnesshub-backup",
      ),
    ),
    at({ ...base, url: "s3://bkt", endpoint: "http://127.0.0.1:9000" }).then(
      (call) =>
        assert.equal(
          call.url,
          "http://127.0.0.1:9000/bkt/harnesshub/harnesshub.harnesshub-backup",
        ),
    ),
    at({
      ...base,
      url: "s3://bkt",
      endpoint: "acct.r2.cloudflarestorage.com",
    }).then((call) =>
      assert.match(call.headers.authorization!, /\/auto\/s3\/aws4_request/),
    ),
  ]).then(() => {
    assert.throws(
      () => new S3Remote({ ...base, url: "https://bucket" }),
      RemoteError,
    );
  });
});
