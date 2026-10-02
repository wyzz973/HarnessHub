import Foundation
import Security
import LocalAuthentication

// Only HarnessHub's namespace is accessible. Requests and values use stdin/stdout,
// never command-line arguments. A new immutable account is created for every key.
struct Request: Decodable { let operation: String; let id: String; let value: String? }
let service = "com.harnesshub.engine-credentials"
func respond(_ value: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: value)
  FileHandle.standardOutput.write(data)
}
do {
  let input = FileHandle.standardInput.readDataToEndOfFile()
  guard input.count <= 32768 else { throw NSError(domain: "input", code: 1) }
  let r = try JSONDecoder().decode(Request.self, from: input)
  guard UUID(uuidString: r.id) != nil else { throw NSError(domain: "id", code: 1) }
  let context = LAContext()
  context.interactionNotAllowed = true
  let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: r.id, kSecUseAuthenticationContext as String: context]
  var status: OSStatus
  switch r.operation {
  case "create":
    guard let value = r.value, !value.isEmpty, value.utf8.count <= 8192 else { throw NSError(domain: "value", code: 1) }
    var attributes = query
    attributes[kSecValueData as String] = value.data(using: .utf8)!
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    status = SecItemAdd(attributes as CFDictionary, nil)
  case "read":
    var lookup = query
    lookup[kSecReturnData as String] = true
    var item: CFTypeRef?
    status = SecItemCopyMatching(lookup as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data, let value = String(data: data, encoding: .utf8) {
      respond(["value": value]); exit(0)
    }
  case "delete": status = SecItemDelete(query as CFDictionary)
  default: throw NSError(domain: "operation", code: 1)
  }
  if status == errSecSuccess { respond(["ok": true]) }
  else { respond(["error": Int(status)]); exit(1) }
} catch { respond(["error": "invalid request"]); exit(1) }
