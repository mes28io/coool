// Where the pairing lives: the private keys (with the ids they belong to) in the iOS Keychain, this device only,
// never synced, never restored to another device; the counters (not secret) in UserDefaults.

import Foundation
import RemoteProtocol
import Security

enum Vault {
  private static let service = "sh.coool.remote"
  private static let account = "pairing"

  private static var query: [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account,
     kSecAttrSynchronizable as String: kCFBooleanFalse!]
  }

  static func load() -> PairedMac? {
    var q = query
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
    return try? JSONDecoder().decode(PairedMac.self, from: data)
  }

  @discardableResult
  static func save(_ m: PairedMac) -> Bool {
    guard let data = try? JSONEncoder().encode(m) else { return false }
    SecItemDelete(query as CFDictionary)
    var q = query
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
  }

  static func forget() {
    SecItemDelete(query as CFDictionary)
    UserDefaults.standard.removeObject(forKey: "recvHighWater")
    UserDefaults.standard.removeObject(forKey: "sendCounter")
  }

  static var recvHighWater: UInt64 {
    get { UInt64(UserDefaults.standard.string(forKey: "recvHighWater") ?? "") ?? 0 }
    set { UserDefaults.standard.set(String(newValue), forKey: "recvHighWater") }
  }
  static var sendCounter: UInt64 {
    get { UInt64(UserDefaults.standard.string(forKey: "sendCounter") ?? "") ?? 0 }
    set { UserDefaults.standard.set(String(newValue), forKey: "sendCounter") }
  }
}
