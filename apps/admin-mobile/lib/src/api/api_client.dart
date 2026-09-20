import 'dart:convert';

import 'package:http/http.dart' as http;

/// What is needed to open a provisioning session with one device. [pop] is a secret: keep it in
/// memory only and never log it.
class ProvisioningInfo {
  const ProvisioningInfo({required this.identity, required this.pop});

  final String identity;
  final String pop;
}

class ApiException implements Exception {
  const ApiException(this.message, {this.statusCode});

  final String message;
  final int? statusCode;

  @override
  String toString() => message;
}

abstract class ApiClient {
  /// GET /api/admin/devices/{identity}/provisioning (requires the `admin` realm role).
  Future<ProvisioningInfo> getProvisioningInfo(String identity);
}

class HttpApiClient implements ApiClient {
  HttpApiClient({required this.baseUrl, required this.accessToken, http.Client? client}) : _client = client ?? http.Client();

  final String baseUrl;
  final Future<String> Function() accessToken;
  final http.Client _client;

  @override
  Future<ProvisioningInfo> getProvisioningInfo(String identity) async {
    final uri = Uri.parse('$baseUrl/api/admin/devices/${Uri.encodeComponent(identity)}/provisioning');
    final http.Response response;
    try {
      response = await _client
          .get(uri, headers: {'authorization': 'Bearer ${await accessToken()}'}).timeout(const Duration(seconds: 15));
    } catch (e) {
      if (e is StateError) rethrow;
      throw ApiException('Could not reach the server at $baseUrl.');
    }

    switch (response.statusCode) {
      case 200:
        final body = jsonDecode(response.body) as Map<String, dynamic>;
        if (body['securityVersion'] != 1) {
          throw const ApiException('This device uses a provisioning security scheme this app does not support.');
        }
        return ProvisioningInfo(identity: body['identity'] as String, pop: body['pop'] as String);
      case 401:
        throw const ApiException('Your session is no longer valid. Sign in again.', statusCode: 401);
      case 403:
        throw const ApiException('Your account is not allowed to provision devices.', statusCode: 403);
      case 404:
        throw ApiException('$identity is not registered. It has to be flashed through the factory app first.', statusCode: 404);
      default:
        throw ApiException('The server returned an error (${response.statusCode}).', statusCode: response.statusCode);
    }
  }
}
