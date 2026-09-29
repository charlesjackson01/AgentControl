// AI-Arch concept QML runner.
//
//   mode live (default): run the QML desktop fullscreen on the current
//                        display (interactive; fit-scaled by the QML root).
//   mode shot:           open the QML window at --w x --h (1920x1080),
//                        wait --settle ms, capture with grabWindow(),
//                        save to --out, and exit. Use with
//                        QT_QPA_PLATFORM=offscreen for headless captures.
//
// Context properties exposed to QML:
//   conceptMode  "live" | "shot"
//   conceptState int   (-1 = interactive)
//   conceptW / conceptH  int
//
// Keys in live mode (handled by the QML): 1-9 demo states, a AI, l
// launcher, q quick settings, n notification, Esc close popups.
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QCommandLineParser>
#include <QCommandLineOption>
#include <QTimer>
#include <QImage>
#include <QFileInfo>
#include <cstdio>

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QCoreApplication::setOrganizationName("ai-arch");
    QCoreApplication::setApplicationName("ai-arch-concept");

    QCommandLineParser parser;
    parser.setApplicationDescription("AI-Arch concept QML prototype runner");
    parser.addHelpOption();
    parser.addVersionOption();

    QCommandLineOption modeOpt({"m", "mode"}, "live or shot", "mode", "live");
    QCommandLineOption stateOpt({"s", "state"}, "demo state to load in shot mode (1-9)", "state", "-1");
    QCommandLineOption outOpt({"o", "out"}, "output PNG path (shot mode)", "out", "/tmp/aiarch-shot.png");
    QCommandLineOption wOpt({"w", "width"}, "capture width (shot mode)", "width", "1920");
    QCommandLineOption hOpt({"H", "height"}, "capture height (shot mode)", "height", "1080");
    QCommandLineOption settleOpt({"t", "settle"}, "ms to wait before capture (shot mode)", "settle", "3000");
    parser.addOption(modeOpt);
    parser.addOption(stateOpt);
    parser.addOption(outOpt);
    parser.addOption(wOpt);
    parser.addOption(hOpt);
    parser.addOption(settleOpt);
    parser.addPositionalArgument("qml", "QML file to load (default: main.qml next to the binary dir)");
    parser.process(app);

    const QString mode = parser.value(modeOpt);
    const int state = parser.value(stateOpt).toInt();
    const QString out = parser.value(outOpt);
    const int w = parser.value(wOpt).toInt();
    const int h = parser.value(hOpt).toInt();
    const int settle = parser.value(settleOpt).toInt();

    QString qmlFile = parser.positionalArguments().value(0);
    if (qmlFile.isEmpty())
        qmlFile = QCoreApplication::applicationDirPath() + "/main.qml";

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("conceptMode", mode);
    engine.rootContext()->setContextProperty("conceptState", state);
    engine.rootContext()->setContextProperty("conceptW", w);
    engine.rootContext()->setContextProperty("conceptH", h);
    engine.load(QUrl::fromLocalFile(QFileInfo(qmlFile).absoluteFilePath()));

    if (engine.rootObjects().isEmpty()) {
        std::fprintf(stderr, "RUNNER: no root objects loaded\n");
        return 1;
    }

    QQuickWindow *win = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    if (!win) {
        std::fprintf(stderr, "RUNNER: root object is not a QQuickWindow\n");
        return 1;
    }

    if (mode == "shot") {
        win->resize(w, h);
        win->show();
        std::fprintf(stderr, "RUNNER: shot mode %dx%d settle=%dms out=%s\n", w, h, settle, out.toUtf8().constData());
        QTimer::singleShot(settle, win, [win, out]() {
            const QImage img = win->grabWindow();
            const bool ok = !img.isNull() && img.save(out);
            std::fprintf(stderr, "RUNNER: capture %s %s\n", ok ? "OK" : "FAILED", out.toUtf8().constData());
            QCoreApplication::exit(ok ? 0 : 2);
        });
    } else {
        win->show();
    }

    return app.exec();
}
