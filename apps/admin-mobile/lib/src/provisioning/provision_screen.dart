import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../app.dart';
import '../ble/ble_scanner.dart';
import 'provisioner.dart';

enum _Phase { preparing, needsPop, pickNetwork, enterPassword, joining, done, failed }

class ProvisionScreen extends StatefulWidget {
  const ProvisionScreen({super.key, required this.services, required this.device});

  final AppServices services;
  final DiscoveredDevice device;

  @override
  State<ProvisionScreen> createState() => _ProvisionScreenState();
}

class _ProvisionScreenState extends State<ProvisionScreen> {
  _Phase _phase = _Phase.preparing;
  String _status = '';
  String? _error;
  ProvisioningSession? _session;
  List<WifiNetwork> _networks = const [];
  WifiNetwork? _selected;
  String? _ipAddress;
  bool _scanningWifi = false;

  final _popController = TextEditingController();
  final _ssidController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _showPassword = false;

  @override
  void initState() {
    super.initState();
    _begin();
  }

  @override
  void dispose() {
    _session?.close();
    _popController.dispose();
    _ssidController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  /// Factory-flashed devices are looked up in the backend; for anything else the admin has to
  /// supply the proof-of-possession by hand.
  Future<void> _begin() async {
    final identity = widget.device.identity;
    if (identity == null) {
      setState(() => _phase = _Phase.needsPop);
      return;
    }
    _setStatus('Fetching credentials for $identity…');
    try {
      final info = await widget.services.api.getProvisioningInfo(identity);
      await _openSession(info.pop);
    } on ApiException catch (e) {
      _fail(e.message);
    } on StateError {
      // Session expired: AuthController already sent the user back to the login screen.
      if (mounted) Navigator.of(context).popUntil((route) => route.isFirst);
    }
  }

  Future<void> _openSession(String pop) async {
    _setStatus('Connecting to ${widget.device.name}…');
    try {
      await _session?.close();
      _session = await widget.services.provisioner.open(deviceId: widget.device.id, pop: pop);
      await _scanWifi();
    } on PopRejectedException {
      _fail(widget.device.identity == null
          ? 'The device rejected that proof-of-possession.'
          : 'The device rejected its proof-of-possession. It may have been re-flashed outside the factory app.');
    } on ProvisioningException catch (e) {
      _fail(e.message);
    } catch (e) {
      _fail('Something went wrong while talking to the device.');
      debugPrint('provisioning error: $e');
    }
  }

  Future<void> _scanWifi() async {
    if (mounted) {
      setState(() {
        _phase = _Phase.pickNetwork;
        _scanningWifi = true;
        _error = null;
      });
    }
    try {
      final networks = await _session!.scanWifi();
      if (mounted) setState(() => _networks = networks);
    } catch (e) {
      debugPrint('wifi scan failed: $e');
      if (mounted) setState(() => _error = 'The device could not scan for networks. Enter the network name manually.');
    } finally {
      if (mounted) setState(() => _scanningWifi = false);
    }
  }

  void _pick(WifiNetwork? network) {
    setState(() {
      _selected = network;
      _ssidController.text = network?.ssid ?? '';
      _passwordController.clear();
      _error = null;
      _phase = _Phase.enterPassword;
    });
  }

  Future<void> _join() async {
    final ssid = _ssidController.text.trim();
    if (ssid.isEmpty) {
      setState(() => _error = 'Enter the network name.');
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _phase = _Phase.joining;
      _status = 'Connecting ${widget.device.name} to "$ssid"…';
      _error = null;
    });
    try {
      final result = await _session!.connectToWifi(ssid: ssid, password: _passwordController.text);
      if (!mounted) return;
      switch (result) {
        case WifiConnected(:final ipAddress):
          setState(() {
            _ipAddress = ipAddress;
            _phase = _Phase.done;
          });
        case WifiFailed(:final message):
          setState(() {
            _error = message;
            _phase = _Phase.enterPassword;
          });
      }
    } catch (e) {
      debugPrint('join failed: $e');
      _fail('Lost the connection to the device. Its Wi-Fi setup may not have completed.');
    }
  }

  void _setStatus(String status) {
    if (mounted) {
      setState(() {
        _phase = _Phase.preparing;
        _status = status;
        _error = null;
      });
    }
  }

  void _fail(String message) {
    if (mounted) {
      setState(() {
        _phase = _Phase.failed;
        _error = message;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.device.name)),
      body: SafeArea(
        child: switch (_phase) {
          _Phase.preparing || _Phase.joining => _Progress(message: _status),
          _Phase.needsPop => _popForm(context),
          _Phase.pickNetwork => _networkList(context),
          _Phase.enterPassword => _passwordForm(context),
          _Phase.done => _Result(
              icon: Icons.check_circle,
              color: Theme.of(context).colorScheme.primary,
              title: '${widget.device.name} is online',
              detail: _ipAddress == null ? 'Connected to "${_ssidController.text}".' : 'Connected to "${_ssidController.text}" as $_ipAddress.',
              action: FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Done')),
            ),
          _Phase.failed => _Result(
              icon: Icons.error_outline,
              color: Theme.of(context).colorScheme.error,
              title: 'Could not set up this device',
              detail: _error ?? '',
              action: FilledButton.tonal(onPressed: _begin, child: const Text('Try again')),
            ),
        },
      ),
    );
  }

  Widget _popForm(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text('Development board', style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 8),
        const Text('This device was not flashed through the factory app, so the server has no credentials for it. Enter its proof-of-possession.'),
        const SizedBox(height: 24),
        TextField(
          controller: _popController,
          autocorrect: false,
          enableSuggestions: false,
          decoration: const InputDecoration(labelText: 'Proof-of-possession', border: OutlineInputBorder()),
          onSubmitted: (_) => _submitPop(),
        ),
        const SizedBox(height: 16),
        FilledButton(onPressed: _submitPop, child: const Text('Connect')),
      ],
    );
  }

  void _submitPop() {
    final pop = _popController.text.trim();
    if (pop.isNotEmpty) _openSession(pop);
  }

  Widget _networkList(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(24, 16, 12, 8),
          child: Row(
            children: [
              Expanded(child: Text('Choose the Wi-Fi network for this device', style: theme.textTheme.titleMedium)),
              IconButton(onPressed: _scanningWifi ? null : _scanWifi, icon: const Icon(Icons.refresh), tooltip: 'Scan again'),
            ],
          ),
        ),
        if (_scanningWifi) const LinearProgressIndicator(minHeight: 2),
        if (_error != null) Padding(padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8), child: Text(_error!, style: TextStyle(color: theme.colorScheme.error))),
        Expanded(
          child: ListView(
            children: [
              if (_scanningWifi && _networks.isEmpty)
                const Padding(padding: EdgeInsets.all(24), child: Text('The device is scanning for networks…')),
              if (!_scanningWifi && _networks.isEmpty && _error == null)
                const Padding(padding: EdgeInsets.all(24), child: Text('The device found no networks. Only 2.4 GHz networks are supported.')),
              for (final network in _networks)
                ListTile(
                  leading: Icon(_signalIcon(network.rssi)),
                  title: Text(network.ssid),
                  trailing: network.secured ? const Icon(Icons.lock_outline, size: 18) : null,
                  onTap: () => _pick(network),
                ),
              ListTile(leading: const Icon(Icons.add), title: const Text('Other network…'), onTap: () => _pick(null)),
            ],
          ),
        ),
      ],
    );
  }

  Widget _passwordForm(BuildContext context) {
    final open = _selected != null && !_selected!.secured;
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        if (_selected == null)
          TextField(
            controller: _ssidController,
            autocorrect: false,
            decoration: const InputDecoration(labelText: 'Network name (SSID)', border: OutlineInputBorder()),
          )
        else
          Text(_selected!.ssid, style: Theme.of(context).textTheme.titleLarge),
        const SizedBox(height: 16),
        if (!open)
          TextField(
            controller: _passwordController,
            obscureText: !_showPassword,
            autocorrect: false,
            enableSuggestions: false,
            autofocus: _selected != null,
            decoration: InputDecoration(
              labelText: 'Wi-Fi password',
              border: const OutlineInputBorder(),
              errorText: _error,
              suffixIcon: IconButton(
                icon: Icon(_showPassword ? Icons.visibility_off : Icons.visibility),
                tooltip: _showPassword ? 'Hide password' : 'Show password',
                onPressed: () => setState(() => _showPassword = !_showPassword),
              ),
            ),
            onSubmitted: (_) => _join(),
          )
        else if (_error != null)
          Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
        const SizedBox(height: 16),
        FilledButton(onPressed: _join, child: const Text('Connect device')),
        TextButton(onPressed: () => setState(() => _phase = _Phase.pickNetwork), child: const Text('Choose another network')),
      ],
    );
  }

  static IconData _signalIcon(int rssi) => rssi >= -60
      ? Icons.signal_wifi_4_bar
      : rssi >= -75
          ? Icons.network_wifi_3_bar
          : Icons.network_wifi_1_bar;
}

class _Progress extends StatelessWidget {
  const _Progress({required this.message});
  final String message;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [const CircularProgressIndicator(), const SizedBox(height: 24), Text(message, textAlign: TextAlign.center)],
          ),
        ),
      );
}

class _Result extends StatelessWidget {
  const _Result({required this.icon, required this.color, required this.title, required this.detail, required this.action});

  final IconData icon;
  final Color color;
  final String title;
  final String detail;
  final Widget action;

  @override
  Widget build(BuildContext context) => Center(
        child: Padding(
          padding: const EdgeInsets.all(32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 72, color: color),
              const SizedBox(height: 16),
              Text(title, style: Theme.of(context).textTheme.titleLarge, textAlign: TextAlign.center),
              const SizedBox(height: 8),
              Text(detail, textAlign: TextAlign.center),
              const SizedBox(height: 24),
              action,
            ],
          ),
        ),
      );
}
