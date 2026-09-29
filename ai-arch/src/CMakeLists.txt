cmake_minimum_required(VERSION 3.25)
project(ai-arch LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Qml Quick Network Sql Test DBus)
qt_policy(SET QTP0001 NEW)

enable_testing()

add_subdirectory(ui)
add_subdirectory(services)
add_subdirectory(tests)

# D-Bus interface definitions + activation files (docs/AI-ARCHITECTURE.md §4)
set(AIARCH_DBUS_XMLS
    org.aiarch.Config
    org.aiarch.AI
    org.aiarch.Permits
    org.aiarch.Context
    org.aiarch.Agents
    org.aiarch.Rag
)
foreach(name ${AIARCH_DBUS_XMLS})
    install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/../dbus/${name}.xml
            DESTINATION share/dbus-1/interfaces)
endforeach()

configure_file(${CMAKE_CURRENT_SOURCE_DIR}/../dbus/org.aiarch.Config.service.in
               ${CMAKE_CURRENT_BINARY_DIR}/org.aiarch.Config.service @ONLY)
configure_file(${CMAKE_CURRENT_SOURCE_DIR}/../dbus/org.aiarch.AI.service.in
               ${CMAKE_CURRENT_BINARY_DIR}/org.aiarch.AI.service @ONLY)
install(FILES ${CMAKE_CURRENT_BINARY_DIR}/org.aiarch.Config.service
              ${CMAKE_CURRENT_BINARY_DIR}/org.aiarch.AI.service
        DESTINATION share/dbus-1/services)

install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/etc/ai-arch.json
        DESTINATION share/ai-arch)
