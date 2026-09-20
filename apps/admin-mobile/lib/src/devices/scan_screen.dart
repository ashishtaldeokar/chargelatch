import 'dart:async';

import 'package:flutter/material.dart';

import '../app.dart';
import '../ble/ble_scanner.dart';
import '../provisioning/provision_screen.dart';

class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, required this.services});

  final AppServices services;

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  BleAvailability? _availability;
  List<DiscoveredDevice> _devices = const [];
  StreamSubscription<List<DiscoveredDevice>>? _subscription;
  bool _scanning = false;

  BleScanner get _scanner => widget.services.scanner;

  @override
  void initState() {
    super.initState();
    _subscription = _scanner.devices.listen((devices) {
      if (mounted) setState(() => _devices = devices);
    });
    _startScan();
  }

  @override
  void dispose() {
    _subscription?.cancel();
    _scanner.stop();
    super.dispose();
  }

  Future<void> _startScan() async {
    final availability = await _scanner.prepare();
    if (!mounted) return;
    setState(() {
      _availability = availability;
      _devices = const [];
    });
    if (availability != BleAvailability.ready) return;
    await _scanner.start();
    if (mounted) setState(() => _scanning = true);
  }

  Future<void> _open(DiscoveredDevice device) async {
    // Android cannot reliably connect while a scan is running.
    await _scanner.stop();
    if (!mounted) return;
    setState(() => _scanning = false);
    await Navigator.of(context).push(
      MaterialPageRoute<void>(builder: (_) => ProvisionScreen(services: widget.services, device: device)),
    );
    // A freshly provisioned device stops advertising, so rescan rather than show a stale list.
    if (mounted) await _startScan();
  }

  @override
  Widget build(BuildContext context) {
    final auth = widget.services.auth;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Nearby devices'),
        actions: [
          PopupMenuButton<String>(
            icon: const Icon(Icons.account_circle_outlined),
            onSelected: (_) => auth.signOut(),
            itemBuilder: (_) => [
              PopupMenuItem(enabled: false, child: Text(auth.session?.email ?? 'Signed in')),
              const PopupMenuItem(value: 'signout', child: Text('Sign out')),
            ],
          ),
        ],
        bottom: _scanning ? const PreferredSize(preferredSize: Size.fromHeight(2), child: LinearProgressIndicator(minHeight: 2)) : null,
      ),
      body: RefreshIndicator(onRefresh: _startScan, child: _body(context)),
    );
  }

  Widget _body(BuildContext context) {
    final problem = switch (_availability) {
      null || BleAvailability.ready => null,
      BleAvailability.poweredOff => ('Bluetooth is off', 'Turn Bluetooth on to find devices.', Icons.bluetooth_disabled),
      BleAvailability.unauthorized => ('Bluetooth permission needed', 'Allow Bluetooth access for this app in system settings.', Icons.block),
      BleAvailability.unsupported => ('Bluetooth LE is not supported on this device', '', Icons.error_outline),
    };
    if (problem != null) {
      return _Message(title: problem.$1, detail: problem.$2, icon: problem.$3, action: FilledButton.tonal(onPressed: _startScan, child: const Text('Try again')));
    }
    if (_devices.isEmpty) {
      return const _Message(
        title: 'Looking for devices…',
        detail: 'Power on a device that has not been set up yet. Devices already on Wi-Fi do not show up here.',
        icon: Icons.bluetooth_searching,
      );
    }
    return ListView.separated(
      physics: const AlwaysScrollableScrollPhysics(),
      itemCount: _devices.length,
      separatorBuilder: (_, _) => const Divider(height: 1),
      itemBuilder: (context, index) {
        final device = _devices[index];
        return ListTile(
          leading: const Icon(Icons.ev_station),
          title: Text(device.name),
          subtitle: Text(device.identity == null ? 'Development board (not factory flashed)' : 'Ready to set up'),
          trailing: device.rssi == null ? const Icon(Icons.chevron_right) : Text('${device.rssi} dBm'),
          onTap: () => _open(device),
        );
      },
    );
  }
}

class _Message extends StatelessWidget {
  const _Message({required this.title, required this.detail, required this.icon, this.action});

  final String title;
  final String detail;
  final IconData icon;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Scrollable so pull-to-refresh also works on the empty state.
    return LayoutBuilder(
      builder: (context, constraints) => SingleChildScrollView(
        physics: const AlwaysScrollableScrollPhysics(),
        child: ConstrainedBox(
          constraints: BoxConstraints(minHeight: constraints.maxHeight),
          child: Center(
            child: Padding(
              padding: const EdgeInsets.all(32),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(icon, size: 56, color: theme.colorScheme.onSurfaceVariant),
                  const SizedBox(height: 16),
                  Text(title, style: theme.textTheme.titleMedium, textAlign: TextAlign.center),
                  if (detail.isNotEmpty) ...[
                    const SizedBox(height: 8),
                    Text(detail, textAlign: TextAlign.center, style: TextStyle(color: theme.colorScheme.onSurfaceVariant)),
                  ],
                  if (action != null) ...[const SizedBox(height: 16), action!],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
