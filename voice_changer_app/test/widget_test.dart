// This is a basic Flutter widget test.
//
// To perform an interaction with a widget in your test, use the WidgetTester
// utility in the flutter_test package. For example, you can send tap and scroll
// gestures. You can also use WidgetTester to find child widgets in the widget
// tree, read text, and verify that the values of widget properties are correct.


import 'package:flutter_test/flutter_test.dart';

import 'package:voice_changer_app/main.dart';

void main() {
  testWidgets('Control panel smoke test', (WidgetTester tester) async {
    // Build our app and trigger a frame.
    await tester.pumpWidget(const VoiceChangerApp());

    // Verify that the title and key control panel headers are present.
    expect(find.text('Live Voice Changer'), findsOneWidget);
    expect(find.text('SYSTEM STATE'), findsOneWidget);
    expect(find.text('Server Configuration'), findsOneWidget);
    expect(find.text('Call Settings'), findsOneWidget);
  });
}
