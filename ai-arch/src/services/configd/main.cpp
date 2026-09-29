#include <QCoreApplication>
#include <QDBusConnection>
#include "configd_adaptor.h"

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("aiarch-configd"));
    QCoreApplication::setOrganizationName(QStringLiteral("ai-arch"));

    QDBusConnection conn = QDBusConnection::sessionBus();
    if (!conn.isConnected()) {
        qCritical() << "aiarch-configd: no session bus";
        return 1;
    }
    if (!conn.registerService(QStringLiteral("org.aiarch.Config")))
        return 0; // another instance owns the name (activation semantics)

    ConfigAdaptor adaptor;
    adaptor.start();
    conn.registerObject(QStringLiteral("/org/aiarch/Config"), &adaptor);

    return app.exec();
}
