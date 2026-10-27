import { TestApp } from './app';

/** Thin HTTP client for e2e tests: prefixes /api/v1 and attaches a bearer token. */
export class Api {
  constructor(
    private readonly t: TestApp,
    private readonly token?: string,
  ) {}

  as(token: string): Api {
    return new Api(this.t, token);
  }

  private auth<T extends { set: (k: string, v: string) => T }>(req: T): T {
    return this.token ? req.set('Authorization', `Bearer ${this.token}`) : req;
  }

  get(path: string) {
    return this.auth(this.t.http().get(`/api/v1${path}`));
  }

  post(path: string, body: object = {}) {
    return this.auth(this.t.http().post(`/api/v1${path}`).send(body));
  }

  patch(path: string, body: object = {}) {
    return this.auth(this.t.http().patch(`/api/v1${path}`).send(body));
  }

  put(path: string, body: object = {}) {
    return this.auth(this.t.http().put(`/api/v1${path}`).send(body));
  }
}

/** Activates a freshly registered device and returns a device access token. */
export async function provisionDevice(admin: Api, anon: Api, groupId: string, identifier: string) {
  const reg = await admin.post('/devices', { deviceIdentifier: identifier, name: `Reader ${identifier}`, assignedGroupId: groupId }).expect(201);
  const { device, credentials } = reg.body.data;
  await admin.post(`/devices/${device.id}/activate`).expect(200);
  const tok = await anon.post('/sync/token', { deviceIdentifier: credentials.deviceIdentifier, secret: credentials.secret }).expect(200);
  return { deviceId: device.id as string, secret: credentials.secret as string, identifier: credentials.deviceIdentifier as string, token: tok.body.data.accessToken as string };
}
