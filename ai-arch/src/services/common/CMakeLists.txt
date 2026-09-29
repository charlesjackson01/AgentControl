add_library(aiarch-common STATIC
    aiarch_paths.cpp
    aiarch_config.cpp
    secret_store.cpp
    aiarch_db.cpp
)
target_include_directories(aiarch-common PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(aiarch-common PUBLIC Qt6::Core Qt6::Network Qt6::Sql)
