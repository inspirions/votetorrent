//
//  AttestationNative.m — RCT_EXTERN_MODULE registration shim for AttestationNativeModule.swift.
//
//  WHY THIS FILE EXISTS: AttestationNativeModule.swift is a plain `NSObject` annotated
//  `@objc(AttestationNative)`. Swift alone cannot register a module with React Native — the
//  RCT_EXTERN_MODULE / RCT_EXTERN_METHOD macros are C preprocessor macros and must live in an
//  Objective-C translation unit. Without this file the Swift compiles cleanly, the podspec links
//  it, and `TurboModuleRegistry.getEnforcing('AttestationNative')` still throws at runtime — the
//  failure mode looks like a JS bug, not a missing build file.
//
//  The selectors below must match `@objc(...)` in the Swift EXACTLY, including every argument
//  label and trailing colon. A mismatch is not a compile error: it produces an
//  "unrecognized selector" crash the first time JS calls the method.
//
#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE (AttestationNative, NSObject)

RCT_EXTERN_METHOD(provisionDeviceKey:(NSString *)keyAlias
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(produceAttestation:(NSString *)keyAlias
                  boundDigest:(NSString *)boundDigest
                  assertionDigest:(NSString *)assertionDigest
                  enableDeviceCheck:(BOOL)enableDeviceCheck
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(signWithDeviceKey:(NSString *)keyAlias
                  digestBase64:(NSString *)digestBase64
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(provisionRecoveryKey:(NSString *)keyAlias
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(signWithRecoveryKey:(NSString *)keyAlias
                  digestBase64:(NSString *)digestBase64
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

// D-42 (Phase 62 plan 08) — generic secret-wrap. Selectors must match the Swift
// `@objc(wrapSecret:plaintextBase64:aadBase64:requireAuth:promptTitle:promptSubtitle:
// promptNegativeButton:resolver:rejecter:)` / `@objc(unwrapSecret:ciphertextBase64:ivBase64:
// aadBase64:requireAuth:promptTitle:promptSubtitle:promptNegativeButton:resolver:rejecter:)`
// strings EXACTLY (see this file's header comment).
RCT_EXTERN_METHOD(wrapSecret:(NSString *)keyAlias
                  plaintextBase64:(NSString *)plaintextBase64
                  aadBase64:(NSString *)aadBase64
                  requireAuth:(BOOL)requireAuth
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(unwrapSecret:(NSString *)keyAlias
                  ciphertextBase64:(NSString *)ciphertextBase64
                  ivBase64:(NSString *)ivBase64
                  aadBase64:(NSString *)aadBase64
                  requireAuth:(BOOL)requireAuth
                  promptTitle:(NSString *)promptTitle
                  promptSubtitle:(NSString *)promptSubtitle
                  promptNegativeButton:(NSString *)promptNegativeButton
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

+ (BOOL)requiresMainQueueSetup { return NO; }

@end
