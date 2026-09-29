add_executable(qml-runner runner.cpp)
target_link_libraries(qml-runner PRIVATE Qt6::Gui Qt6::Qml)
