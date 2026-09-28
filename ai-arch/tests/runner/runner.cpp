// AIArch production QML runner (generalized from concept/qml/run/runner.cpp,
// docs/TESTING.md §3). Loads a QML file; in shot mode it captures at a fixed
// size under QT_QPA_PLATFORM=offscreen.
//
// Context properties: runnerMode ("live"|"shot"), runnerState int,
// runnerW / runnerH int.
// --import-path adds QML import directories (built AIArch.Ui module).
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickWindow>
#include <QCommandLineParser>
#include <QCommandLineOption>
#include <QTimer>
#include <QImage>
#include <QDir>
#include <QFileInfo>
#include <cstdio>

int main(int argc, char *argv[])
{
    QGuiApplication app(argc, argv);
    QCoreApplication::setOrganizationName(QStringLiteral("ai-arch"));
    QCoreApplication::setApplicationName(QStringLiteral("ai-arch-uitest"));

    QCommandLineParser parser;
    parser.setApplicationDescription("AIArch.Ui offscreen/liven QML runner");
    parser.addHelpOption();

    QCommandLineOption modeOpt({"m", "mode"}, "live or shot", "mode", "live");
    QCommandLineOption stateOpt({"s", "state"}, "mock state for shot mode", "state", "0");
    QCommandLineOption outOpt({"o", "out"}, "output PNG path (shot mode)", "out", "/tmp/aiarch-uitest.png");
    QCommandLineOption wOpt({"w", "width"}, "capture width", "width", "1920");
    QCommandLineOption hOpt({"H", "height"}, "capture height", "height", "1080");
    QCommandLineOption settleOpt({"t", "settle"}, "ms before capture", "settle", "2500");
    QCommandLineOption importOpt({"i", "import-path"}, "extra QML import dirs (repeatable)", "dir");
    parser.addOption(modeOpt);
    parser.addOption(stateOpt);
    parser.addOption(outOpt);
    parser.addOption(wOpt);
    parser.addOption(hOpt);
    parser.addOption(settleOpt);
    parser.addOption(importOpt);
    parser.addPositionalArgument("qml", "QML file to load");
    parser.process(app);

    {
        QString all = qEnvironmentVariable("QML_IMPORT_PATH", "");
        for (const QString &dir : parser.values(importOpt))
            all += (all.isEmpty() ? QString() : QStringLiteral(":")) + dir;
        if (!all.isEmpty())
            qputenv("QML_IMPORT_PATH", all.toUtf8());
    }

    const QString mode = parser.value(modeOpt);
    const int state = parser.value(stateOpt).toInt();
    const QString out = parser.value(outOpt);
    const int w = parser.value(wOpt).toInt();
    const int h = parser.value(hOpt).toInt();
    const int settle = parser.value(settleOpt).toInt();
    const QString qmlFile = parser.positionalArguments().value(0);
    if (qmlFile.isEmpty()) {
        std::fprintf(stderr, "runner: no QML file given\n");
        return 1;
    }

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("runnerMode", mode);
    engine.rootContext()->setContextProperty("runnerState", state);
    engine.rootContext()->setContextProperty("runnerW", w);
    engine.rootContext()->setContextProperty("runnerH", h);
    engine.load(QUrl::fromLocalFile(QFileInfo(qmlFile).absoluteFilePath()));

    if (engine.rootObjects().isEmpty()) {
        std::fprintf(stderr, "runner: no root objects loaded\n");
        return 1;
    }
    auto *win = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    if (!win) {
        std::fprintf(stderr, "runner: root object is not a QQuickWindow\n");
        return 1;
    }

    if (mode == "shot") {
        win->resize(w, h);
        win->show();
        QTimer::singleShot(settle, win, [win, out]() {
            const QImage img = win->grabWindow();
            const bool ok = !img.isNull() && img.save(out);
            std::fprintf(stderr, "runner: capture %s %s\n", ok ? "OK" : "FAILED", out.toUtf8().constData());
            QCoreApplication::exit(ok ? 0 : 2);
        });
    } else {
        win->show();
    }
    return app.exec();
}
