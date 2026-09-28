qt6_add_qml_module(AIArchUi
    URI AIArch.Ui
    VERSION 1.0
    OUTPUT_DIRECTORY AIArch/Ui
    QML_FILES
        Theme.qml
        Surface.qml
        Chip.qml
        Glyph.qml
        StatusDot.qml
        AIBar.qml
)
target_link_libraries(AIArchUi PRIVATE Qt6::Quick)
install(TARGETS AIArchUi LIBRARY DESTINATION lib)
install(TARGETS AIArchUiplugin LIBRARY DESTINATION lib/qt6/qml/AIArch/Ui)
install(FILES
    ${CMAKE_CURRENT_BINARY_DIR}/AIArch/Ui/qmldir
    ${CMAKE_CURRENT_BINARY_DIR}/AIArch/Ui/AIArchUi.qmltypes
    DESTINATION lib/qt6/qml/AIArch/Ui)
