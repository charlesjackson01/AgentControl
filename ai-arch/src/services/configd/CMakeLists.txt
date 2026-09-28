add_executable(aiarch-configd
    main.cpp
    configd_adaptor.cpp
)
target_link_libraries(aiarch-configd PRIVATE aiarch-common Qt6::Core Qt6::DBus)
install(TARGETS aiarch-configd RUNTIME DESTINATION bin)
