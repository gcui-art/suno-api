'use client';
/**
 * 
 * @param param0 
 * @returns 
 */
export default function Section({
    children,
    className
}: {
    children?: React.ReactNode | string,
    className?: string
}) {

    return (
        <section className={`mx-auto w-full px-4 lg:px-0 ${className}`} >
            <div className=" max-w-3xl mx-auto">
                {children}
            </div>
        </section>
    );
};
