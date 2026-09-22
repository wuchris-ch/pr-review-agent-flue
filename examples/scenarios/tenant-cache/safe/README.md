Orders belong to a tenant. Cache hits must enforce the same tenant boundary as database reads, including when tenants reuse the same order identifier.
