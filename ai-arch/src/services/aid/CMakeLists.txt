add_executable(aiarch-aid
    main.cpp
    gateway.cpp
    aid_adaptor.cpp
    sse.cpp
)
target_link_libraries(aiarch-aid PRIVATE aiarch-common Qt6::Core Qt6::DBus Qt6::Network)
install(TARGETS aiarch-aid RUNTIME DESTINATION bin)
